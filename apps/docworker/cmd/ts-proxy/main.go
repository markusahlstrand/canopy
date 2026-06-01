// Command ts-proxy joins a Tailscale tailnet in userspace mode and exposes a
// local HTTP CONNECT proxy, so the Node document service beside it can reach a
// tailnet-only host (a Synology NAS) without the container needing a TUN device
// or elevated capabilities.
//
// This is the piece a Cloudflare Worker can't be: a real process running the
// Tailscale (WireGuard) data plane. tsnet uses a userspace netstack — no
// /dev/net/tun, no NET_ADMIN — and falls back to DERP-relay over HTTPS/443 when
// direct UDP is unavailable (as it is on the Cloudflare Containers egress).
//
// Env:
//   TS_AUTHKEY        ephemeral, tagged Tailscale auth key (required)
//   TS_HOSTNAME       tailnet node name           (default "canopy-docworker")
//   TS_PROXY_LISTEN   local CONNECT proxy address  (default "127.0.0.1:1055")
//   TS_STATE_DIR      tsnet state dir              (default "/tmp/tsnet")
package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"os"

	"tailscale.com/tsnet"
)

func main() {
	srv := &tsnet.Server{
		Hostname:  envOr("TS_HOSTNAME", "canopy-docworker"),
		AuthKey:   os.Getenv("TS_AUTHKEY"),
		Dir:       envOr("TS_STATE_DIR", "/tmp/tsnet"),
		Ephemeral: true,
	}
	defer srv.Close()

	// Bring the node onto the tailnet before accepting proxy traffic.
	if _, err := srv.Up(context.Background()); err != nil {
		log.Fatalf("[ts-proxy] tailscale up failed: %v", err)
	}
	listen := envOr("TS_PROXY_LISTEN", "127.0.0.1:1055")
	log.Printf("[ts-proxy] tailnet node %q up; CONNECT proxy listening on %s", srv.Hostname, listen)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "this proxy only supports CONNECT", http.StatusMethodNotAllowed)
			return
		}
		connect(srv, w, r)
	})
	log.Fatal((&http.Server{Addr: listen, Handler: handler}).ListenAndServe())
}

// connect tunnels a CONNECT request to its target over the tailnet, dialing via
// tsnet so the destination is resolved and routed inside the tailnet.
func connect(srv *tsnet.Server, w http.ResponseWriter, r *http.Request) {
	upstream, err := srv.Dial(r.Context(), "tcp", r.Host) // r.Host is "host:port"
	if err != nil {
		http.Error(w, "tailnet dial failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "server does not support hijacking", http.StatusInternalServerError)
		return
	}
	client, _, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()

	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	go func() { _, _ = io.Copy(upstream, client) }()
	_, _ = io.Copy(client, upstream)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
