/**
 * The vertical's front end build.
 *
 * `root: 'app'` keeps the SPA's sources in one directory beside the worker's,
 * while the package stays ONE npm package. That is deliberate: the substrat demos
 * make `app/` a nested workspace member and build it with
 * `npm --prefix app install`, which in this repo would install a second, detached
 * node_modules and break the `@canopy/ui` workspace link — the components would
 * resolve to nothing. One package, one install, links intact.
 *
 * The output lands in `app/dist`, which is what `substrat.runtimeNeeds.assets`
 * points at: `substrat push` runs the build, hashes the output and uploads it to
 * the runtime's asset store.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'app',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5769,
    strictPort: true,
    // `wrangler dev --var ALLOW_DEV_NODE:true` serves the worker on 8787; without
    // this the dev SPA calls its own origin and gets Vite's index.html back for
    // every API request.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
