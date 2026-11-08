---
"@canopy/connector-a3docs": patch
"@canopy/drive-vertical": patch
---

Connecting a3doc no longer fails with "a3doc signIn failed: error 3 (Error en los parámetros indicados en la llamada.)". The connector now signs in with the same device fields a3doc's own web app sends, including its fixed device id, instead of an id of its own that a3doc refuses.
