/**
 * Props the host passes to a trusted file viewer/editor — the contract between the
 * host's file-preview surface and a plugin's React view. The host owns file access
 * and hands the plugin only identifiers; the plugin reads/writes content through the
 * {@link HostBridge}.
 */
export interface FileViewProps {
  fileId: string;
  fileName: string;
  /** Space the file lives in, when known — lets a viewer list sibling files. */
  spaceId?: string;
  /** The file's full drive path, when known — used to scope folder discovery. */
  filePath?: string;
  /** Called after the viewer saves a new version, so the host can refresh. */
  onSaved?: () => void;
}
