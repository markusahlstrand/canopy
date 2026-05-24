import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Canopy',
        short_name: 'Canopy',
        description: 'An extensible, plugin-driven file portal.',
        theme_color: '#3F7A55',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // SPA: serve the cached app shell for navigations (but never for the API).
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Offline browsing of already-seen file listings/contents (reads only).
        runtimeCaching: [
          {
            urlPattern: /\/api\/(files|file)(\?|$)/,
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: 'canopy-api',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // SW only in the production build; dev keeps plain Vite + HMR.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5768,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8787',
      // WebDAV lives on the API too; proxy it so the mount URL the UI builds
      // from window.location.origin (port 5768) works in dev.
      '/dav': 'http://localhost:8787',
      // Public share landing (/s/<secret>) is served by the API as well.
      // Regex (not bare '/s') so it only matches the share path and doesn't
      // swallow '/src/*', '/sw.js', etc. — those must stay served by Vite.
      '^/s/': 'http://localhost:8787',
    },
  },
})
