import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'

// Self-healing service worker. `registerType: 'autoUpdate'` makes a newly-built
// worker take over and reload the page automatically — but the browser only
// looks for a new worker on a full navigation, which an SPA almost never does,
// so a long-open tab can keep serving the previous cached shell. Polling
// `update()` makes such a tab discover a new deploy within the interval instead
// of waiting for a manual hard-reload / cache clear. No-op in dev (the SW is
// disabled there — see devOptions in vite.config.ts).
const SW_UPDATE_INTERVAL_MS = 60_000
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (registration) setInterval(() => void registration.update(), SW_UPDATE_INTERVAL_MS)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
