---
"@canopy/drive-vertical": patch
"@canopy/scope-drive": patch
"@canopy/connector-a3docs": patch
---

Review fixes: a mail folder is dated from arrival when the Date header did not parse; a stored sync report that is not JSON no longer hides the source; reconnecting a3doc under another name for the same folder reads it in full so its report returns; a3doc's MFA status is read when sent as text; Sync now's 429 says a sync started (connecting starts one); and after a link that failed for a retryable reason, the address follows the screen again once you move on.
