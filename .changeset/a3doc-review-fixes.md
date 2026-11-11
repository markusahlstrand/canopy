---
"@canopy/scope-drive": patch
"@canopy/drive-vertical": patch
"@canopy/connector-a3docs": patch
---

a3doc sync reports hold up better. A folder typed as `/Facturas/` or `Facturas` is now one folder, so its report shows. A re-connect under another spelling, or a report that couldn't be saved, gets a fresh full read instead of no report until the next daily pass. The empty-folder note now updates when the first sync finishes, and is only fetched when that note is shown. A failed reconnect shows a3doc's own refusal, and an MFA status a3doc sends as text is read correctly.
