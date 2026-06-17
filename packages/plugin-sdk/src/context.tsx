import { createContext, useContext, type ReactNode } from "react";
import type { HostBridge } from "./host";

const HostBridgeContext = createContext<HostBridge | null>(null);

export function PluginHostProvider({ value, children }: { value: HostBridge; children: ReactNode }) {
  return <HostBridgeContext.Provider value={value}>{children}</HostBridgeContext.Provider>;
}

/**
 * The host capability bridge. Throws when used outside a {@link PluginHostProvider}
 * — a plugin that needs host access can't function without it. Use
 * {@link useOptionalPluginHost} for features that should degrade gracefully when
 * the host bridge isn't present.
 */
export function usePluginHost(): HostBridge {
  const host = useContext(HostBridgeContext);
  if (!host) throw new Error("usePluginHost must be used within a PluginHostProvider");
  return host;
}

/** The host bridge, or null when rendered outside a provider. Callers must guard. */
export function useOptionalPluginHost(): HostBridge | null {
  return useContext(HostBridgeContext);
}
