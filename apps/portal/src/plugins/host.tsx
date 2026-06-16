import { createContext, useContext, type ReactNode } from "react";
import type { FileItem } from "@/lib/mock-data";

/**
 * Imperative host actions available to trusted, first-party plugin UI (the React
 * components in {@link PLUGIN_UI}). These let a plugin reach back into the host
 * for things it can't do from inside its own view — creating a drive file, opening
 * a preview — without the host having to wire a bespoke callback per plugin.
 *
 * Keep this surface small and generic: anything added here is offered to *every*
 * trusted plugin, so it must read as a host capability, never as one plugin's hook.
 * Untrusted/sandboxed plugins never see this — they go through the capability
 * bridge instead.
 */
export interface HostApi {
  /** True while the client is online; drive mutations are blocked offline. */
  online: boolean;
  /**
   * Create a file at the root of the user's drive and open it full-screen in its
   * matching viewer. Returns the created file, or null if it was blocked (offline)
   * or failed — the host surfaces the reason to the user.
   */
  createAndOpenFile(input: { name: string; content: string; mime?: string }): Promise<FileItem | null>;
}

const HostApiContext = createContext<HostApi | null>(null);

export function HostApiProvider({ value, children }: { value: HostApi; children: ReactNode }) {
  return <HostApiContext.Provider value={value}>{children}</HostApiContext.Provider>;
}

/**
 * The host action bridge, or null when rendered outside a provider (e.g. a plugin
 * view mounted in a context that doesn't offer host actions). Callers must guard.
 */
export function useHostApi(): HostApi | null {
  return useContext(HostApiContext);
}
