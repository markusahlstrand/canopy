---
"@canopy/connector-a3docs": patch
"@canopy/drive-vertical": patch
---

Connecting a3doc no longer fails with "a3doc signIn failed: error 3 (Error en los parámetros indicados en la llamada.)". The connector now signs in the way a3doc's own login form does: `LoginMfaBegin`, then `LoginMfaComplete`, with the web app's device fields. a3doc only uses `signIn` for its silent refresh, and it refuses a plain login there. Optional MFA is skipped, as the form's skip button does. When a3doc makes MFA mandatory for a user, connecting says so instead of failing with a code.
