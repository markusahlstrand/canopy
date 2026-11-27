---
"@canopy/scope-drive": minor
"@canopy/drive-vertical": minor
---

Suggestions has a new "People and companies" tab where you can merge two or more entities that are really one. It lists the people, companies and places your documents name, and puts names that look alike first ("Acme" and "ACME Servicios"). Pick them, choose which name to keep, and merge. Everything the documents say about the others moves to the one you keep. The old names become aliases, so the next document that uses one is matched to the kept entity instead of bringing the duplicate back. A merge is refused when the two have different accepted VAT numbers, NIFs or org numbers, and it needs write access to the whole space. Each merge is logged with what it changed (migration 0020).
