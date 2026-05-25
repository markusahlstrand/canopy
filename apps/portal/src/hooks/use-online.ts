import { useSyncExternalStore } from "react";
import { isBackendReachable, subscribeReachable } from "@/lib/connectivity";

function subscribeBrowser(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

const browserOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine);

/**
 * Whether the app can reach its backend: the browser is online *and* the last
 * API call got a response. Returns false the moment a request fails against an
 * unreachable server — not just when the OS reports the network down — so the
 * offline banner and write-gating react to a stopped dev server too.
 */
export function useOnline(): boolean {
  const online = useSyncExternalStore(subscribeBrowser, browserOnline, () => true);
  const backendOk = useSyncExternalStore(subscribeReachable, isBackendReachable, () => true);
  return online && backendOk;
}
