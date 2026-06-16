import { useSyncExternalStore } from "react";
import { getMirrorVersion, getSyncStatus, subscribeSync, type SyncStatus } from "@/lib/sync";

const SERVER_STATUS: SyncStatus = { syncing: false, lastSyncedAt: 0, error: false };

/**
 * A token that changes whenever the offline mirror's rows change (a background pull
 * applied a delta). Include it in a data-load effect's deps so the view re-renders
 * from the freshly-synced mirror without a manual refresh.
 */
export function useMirrorVersion(): number {
  return useSyncExternalStore(subscribeSync, getMirrorVersion, () => 0);
}

/** Current sync status (syncing / last-synced / error) for a status indicator. */
export function useSync(): SyncStatus {
  return useSyncExternalStore(subscribeSync, getSyncStatus, () => SERVER_STATUS);
}
