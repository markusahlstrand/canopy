---
"@canopy/drive-vertical": patch
"@canopy/connector-a3docs": patch
"@canopy/connector-s3": patch
"@canopy/scope-drive": patch
---

Update Substrat to 0.188 (vertical-auth 0.32.1, attachment-extractors 0.2.49, CLI 0.58.2). This fixes binding an a3doc folder, which failed with a bare 500 ("unknown error"): before binding, the platform asks the drive for the connection's grants, and on a CP-less host adapter-cloudflare 0.176 read the tenant's grant tuples through a control plane it does not have. Substrat 0.183 (#2892) reads none there.
