// Side-effect CSS imports are resolved by Vite at build time; declare the module
// so `tsc --noEmit` (which has no bundler ambient types) accepts them.
declare module "*.css";

// `showDirectoryPicker` is part of the File System Access API but isn't in the
// standard DOM lib types yet. Declare just the slice the demo relies on.
interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
  }): Promise<FileSystemDirectoryHandle>;
}
