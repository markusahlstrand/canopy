import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// A plain static single-page app: the Model Editor plugin rendered against a
// HostBridge backed by the browser's File System Access API. No backend.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
