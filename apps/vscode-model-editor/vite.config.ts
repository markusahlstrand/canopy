import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Builds the webview UI (the React model-editor) into a single JS + CSS pair with
// stable names, so the extension host can reference them with predictable URIs.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist/webview",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      input: "webview/main.tsx",
      output: {
        format: "es",
        // One JS file: the model-editor lazy-loads its sub-canvases via import(),
        // but dynamic-import chunks would be blocked by the webview's nonce CSP, so
        // disable code splitting and emit a single entry.
        codeSplitting: false,
        entryFileNames: "webview.js",
        assetFileNames: "webview.[ext]",
      },
    },
  },
});
