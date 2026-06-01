import { describe, expect, it } from "vitest";
import { createSynologyConnector, synologyConnectorPlugin, tailscaleBaseUrl } from "./index";
import { candidatesFromServerInfo, resolveQuickConnect } from "./quickconnect";

// ── QuickConnect resolution (pure parsing + the coordinator round-trip) ────────

describe("candidatesFromServerInfo", () => {
  const info = {
    server: {
      ddns: "myhome.synology.me",
      fqdn: "NULL",
      external: { ip: "203.0.113.7" },
      interface: [{ ip: "192.168.1.50", ipv6: { address: "fe80::1" } }],
    },
    service: { port: 5001, ext_port: 5051, relay_ip: "relay.example", relay_port: 443 },
    smartdns: { host: "abc123.de.quickconnect.to" },
    env: { control_host: "quickconnect.to" },
  };

  it("orders remote-reachable candidates first by default", () => {
    const out = candidatesFromServerInfo(info, "abc123");
    // DDNS (with WAN port) leads; LAN interface comes after the remote options.
    expect(out[0]).toBe("https://myhome.synology.me:5051");
    expect(out).toContain("https://203.0.113.7:5051");
    expect(out).toContain("https://abc123.de.quickconnect.to");
    expect(out).toContain("https://abc123.quickconnect.to");
    expect(out).toContain("https://192.168.1.50:5001");
    expect(out.indexOf("https://myhome.synology.me:5051")).toBeLessThan(out.indexOf("https://192.168.1.50:5001"));
  });

  it("puts LAN candidates first when preferLan is set", () => {
    const out = candidatesFromServerInfo(info, "abc123", true);
    expect(out[0]).toBe("https://192.168.1.50:5001");
  });

  it("tries hostname candidates before bare-IP ones (edge fetch by IP hits Cloudflare 1003)", () => {
    const out = candidatesFromServerInfo(info, "abc123");
    const bareIp = out.indexOf("https://203.0.113.7:5051"); // server.external.ip
    expect(bareIp).toBeGreaterThan(out.indexOf("https://myhome.synology.me:5051"));
    expect(bareIp).toBeGreaterThan(out.indexOf("https://abc123.de.quickconnect.to"));
    expect(bareIp).toBeGreaterThan(out.indexOf("https://abc123.quickconnect.to"));
  });

  it("skips NULL/empty fields and de-dupes", () => {
    const out = candidatesFromServerInfo({ server: { fqdn: "NULL", ddns: "" }, service: {} }, "x");
    expect(out.every((u) => !u.includes("NULL"))).toBe(true);
    expect(new Set(out).size).toBe(out.length);
  });
});

describe("resolveQuickConnect", () => {
  it("POSTs get_server_info and returns candidates", async () => {
    let body: unknown;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ errno: 0, server: { ddns: "h.synology.me" }, service: { ext_port: 5051 } }));
    }) as unknown as typeof fetch;
    const out = await resolveQuickConnect("myid", { fetchImpl });
    expect((body as { serverID: string }).serverID).toBe("myid");
    expect(out).toContain("https://h.synology.me:5051");
  });

  it("throws a clear error for an unknown id (errno 4)", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ errno: 4 }))) as unknown as typeof fetch;
    await expect(resolveQuickConnect("nope", { fetchImpl })).rejects.toThrow(/Unknown QuickConnect ID/);
  });
});

// ── Tailscale base-URL synthesis ───────────────────────────────────────────────

describe("tailscaleBaseUrl", () => {
  it("defaults a bare MagicDNS host to plain HTTP on DSM's 5000", () => {
    expect(tailscaleBaseUrl("nas.tailnet.ts.net")).toBe("http://nas.tailnet.ts.net:5000");
  });

  it("defaults a bare 100.x tailnet IP the same way", () => {
    expect(tailscaleBaseUrl("100.101.102.103")).toBe("http://100.101.102.103:5000");
  });

  it("keeps an explicit port (assuming http over the tailnet)", () => {
    expect(tailscaleBaseUrl("nas.tailnet.ts.net:5001")).toBe("http://nas.tailnet.ts.net:5001");
  });

  it("respects a full URL as-is and trims a trailing slash", () => {
    expect(tailscaleBaseUrl("https://nas.tailnet.ts.net:5001/")).toBe("https://nas.tailnet.ts.net:5001");
  });
});

describe("synologyConnectorPlugin.create", () => {
  it("builds a connector from a tailscaleHost (no baseUrl needed)", () => {
    const c = synologyConnectorPlugin.create("connector:synology", {
      account: "u",
      password: "p",
      tailscaleHost: "nas.tailnet.ts.net",
    });
    expect(c).not.toBeNull();
  });

  it("requires a baseUrl, tailscaleHost, or quickConnectId", () => {
    expect(() => synologyConnectorPlugin.create("connector:synology", { account: "u", password: "p" })).toThrow(
      /baseUrl.*tailscaleHost.*quickConnectId/,
    );
  });
});

// ── A fake DSM Web API to drive the connector against ──────────────────────────

function fakeNas(opts: { expireSidOnce?: boolean } = {}) {
  const calls: string[] = [];
  let uploaded: { name: string; bytes: number } | null = null;
  let sidExpired = !!opts.expireSidOnce;
  let logins = 0;

  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const u = new URL(url);
    const api = u.searchParams.get("api");
    const method = u.searchParams.get("method") ?? "";

    if (api === "SYNO.API.Info") {
      return json({
        success: true,
        data: {
          "SYNO.API.Auth": { path: "auth.cgi", minVersion: 1, maxVersion: 7 },
          "SYNO.FileStation.List": { path: "entry.cgi", minVersion: 1, maxVersion: 2 },
          "SYNO.FileStation.Download": { path: "entry.cgi", minVersion: 1, maxVersion: 2 },
          "SYNO.FileStation.Upload": { path: "entry.cgi", minVersion: 1, maxVersion: 2 },
          "SYNO.FileStation.Delete": { path: "entry.cgi", minVersion: 1, maxVersion: 2 },
          "SYNO.FileStation.CreateFolder": { path: "entry.cgi", minVersion: 1, maxVersion: 2 },
        },
      });
    }
    if (api === "SYNO.API.Auth" && method === "login") {
      logins++;
      return json({ success: true, data: { sid: `SID-${logins}` } });
    }

    // Simulate a one-time expired session on the first authed call.
    if (sidExpired && api?.startsWith("SYNO.FileStation")) {
      sidExpired = false;
      return json({ success: false, error: { code: 119 } });
    }

    if (api === "SYNO.FileStation.List" && method === "list") {
      const folder = u.searchParams.get("folder_path");
      if (folder === "/home/missing") return json({ success: false, error: { code: 408 } });
      return json({
        success: true,
        data: {
          files: [
            { name: "sub", path: "/home/sub", isdir: true },
            { name: "a.txt", path: "/home/a.txt", isdir: false, additional: { size: 12, time: { mtime: 1700000000 } } },
          ],
        },
      });
    }
    if (api === "SYNO.FileStation.List" && method === "getinfo") {
      return json({ success: true, data: { files: [{ name: "a.txt", path: "/home/a.txt", isdir: false, additional: { size: 12 } }] } });
    }
    if (api === "SYNO.FileStation.Download" && method === "download") {
      return new Response("file-contents");
    }
    if (api === "SYNO.FileStation.Delete") return json({ success: true, data: {} });
    if (api === "SYNO.FileStation.CreateFolder") return json({ success: true, data: {} });

    // Upload is a multipart POST; api/method/filename arrive in the form body.
    if (init?.method === "POST" && init.body instanceof FormData) {
      const form = init.body;
      if (form.get("api") === "SYNO.FileStation.Upload") {
        const file = form.get("file") as Blob;
        uploaded = { name: String(form.get("file") instanceof Blob ? (form.get("file") as File).name ?? "" : ""), bytes: file.size };
        return json({ success: true, data: {} });
      }
    }

    return json({ success: false, error: { code: 100 } });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, get uploaded() { return uploaded; }, get logins() { return logins; } };
}

const base = { account: "u", password: "p", baseUrl: "https://nas.test:5001", shareRoot: "/home" };

describe("createSynologyConnector", () => {
  it("lists a folder, mapping files and folders into entries", async () => {
    const nas = fakeNas();
    const c = createSynologyConnector("syn", { ...base, fetchImpl: nas.fetchImpl });
    const page = await c.list("");
    expect(page.items.map((e) => [e.name, e.kind])).toEqual([
      ["sub", "folder"],
      ["a.txt", "file"],
    ]);
    const file = page.items.find((e) => e.kind === "file")!;
    expect(file.path).toBe("a.txt"); // relative to shareRoot "/home"
    expect(file.size).toBe(12);
    expect(file.modifiedAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("returns an empty page for a not-yet-created folder (error 408)", async () => {
    const nas = fakeNas();
    const c = createSynologyConnector("syn", { ...base, fetchImpl: nas.fetchImpl });
    expect(await c.list("missing")).toEqual({ items: [] });
  });

  it("re-authenticates once when the session has expired (error 119)", async () => {
    const nas = fakeNas({ expireSidOnce: true });
    const c = createSynologyConnector("syn", { ...base, fetchImpl: nas.fetchImpl });
    const page = await c.list("");
    expect(page.items).toHaveLength(2);
    expect(nas.logins).toBe(2); // initial login + one refresh
  });

  it("stats a file", async () => {
    const nas = fakeNas();
    const c = createSynologyConnector("syn", { ...base, fetchImpl: nas.fetchImpl });
    const st = await c.stat("a.txt");
    expect(st).toMatchObject({ name: "a.txt", kind: "file", size: 12, path: "a.txt" });
  });

  it("reads a file as a stream", async () => {
    const nas = fakeNas();
    const c = createSynologyConnector("syn", { ...base, fetchImpl: nas.fetchImpl });
    const text = await new Response(await c.read("a.txt")).text();
    expect(text).toBe("file-contents");
  });

  it("writes a file via multipart upload to the parent folder", async () => {
    const nas = fakeNas();
    const c = createSynologyConnector("syn", { ...base, fetchImpl: nas.fetchImpl });
    const entry = await c.write("docs/new.txt", new TextEncoder().encode("hello"));
    expect(entry).toMatchObject({ name: "new.txt", kind: "file", size: 5, path: "docs/new.txt" });
    expect(nas.uploaded?.bytes).toBe(5);
  });

  it("creates a folder and removes a path", async () => {
    const nas = fakeNas();
    const c = createSynologyConnector("syn", { ...base, fetchImpl: nas.fetchImpl });
    await expect(c.mkdir!("docs/photos")).resolves.toBeUndefined();
    await expect(c.remove("docs/old.txt")).resolves.toBeUndefined();
    expect(nas.calls.some((u) => u.includes("CreateFolder"))).toBe(true);
    expect(nas.calls.some((u) => u.includes("Delete"))).toBe(true);
  });

  it("turns a non-JSON edge response (e.g. Cloudflare 1003) into a clear error, not a parse crash", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      // Info discovery is best-effort; let it succeed so we reach login.
      if (u.searchParams.get("api") === "SYNO.API.Info") {
        return new Response(JSON.stringify({ success: true, data: {} }), { headers: { "content-type": "application/json" } });
      }
      return new Response("error code: 1003", { status: 403 }); // Cloudflare "Direct IP Access Not Allowed"
    }) as unknown as typeof fetch;
    const c = createSynologyConnector("syn", { ...base, fetchImpl });
    await expect(c.list("")).rejects.toThrow(/error code: 1003/);
    await expect(c.list("")).rejects.not.toThrow(/Unexpected token/);
  });

  it("enumerates shares at the root when no shareRoot is set", async () => {
    const nas = fakeNas();
    // Override list_share for this case.
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      if (u.searchParams.get("method") === "list_share") {
        return new Response(JSON.stringify({ success: true, data: { shares: [{ name: "home", path: "/home" }, { name: "photo", path: "/photo" }] } }));
      }
      return nas.fetchImpl(input as string, init);
    }) as unknown as typeof fetch;
    const c = createSynologyConnector("syn", { account: "u", password: "p", baseUrl: "https://nas.test:5001", fetchImpl });
    const page = await c.list("");
    expect(page.items.map((e) => e.name)).toEqual(["home", "photo"]);
    expect(page.items.every((e) => e.kind === "folder")).toBe(true);
  });

  it("lists a share subfolder with an ABSOLUTE DSM path when no shareRoot is set", async () => {
    // Without a shareRoot, navigating into a share must send folder_path "/home",
    // not "home" — DSM rejects a relative path with FileStation error 401.
    const nas = fakeNas();
    const c = createSynologyConnector("syn", { account: "u", password: "p", baseUrl: "https://nas.test:5001", fetchImpl: nas.fetchImpl });
    await c.list("home");
    const listCall = nas.calls.find((u) => u.includes("method=list") && u.includes("folder_path"));
    expect(listCall && decodeURIComponent(listCall)).toContain("folder_path=/home");
  });
});
