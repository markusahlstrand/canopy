---
"@canopy/scope-drive": minor
"@canopy/drive-vertical": minor
---

Spaces can now build a knowledge graph from their documents. With "Suggest people and companies" on in space settings, an AI model reads each new document for the people, companies and places it names, and what it says about them: who issued an invoice and who it is for, the total and due date, VAT, NIF and Swedish org numbers, emails, phones, IBANs, who works where. Each statement arrives as a suggestion with the words it was read from. You accept or reject it in the file's Details tab, or all at once from Suggestions in the sidebar. For files that were already there, “Find people and companies” on a folder's menu reads the ones not read yet, 200 at a time with a Continue for the rest. Clicking a name opens its card: what is known about it, which documents it appears in, and who it connects to through them.

The vocabulary is fixed and borrowed from schema.org (Person, Organization, Place, the Invoice properties), plus Spanish and Swedish identifiers. Each value is checked: an IBAN, NIF or org number with a bad checksum is dropped as a misread. Statements are stored as claims in the space's own database (migration 0018). An entity is matched by its VAT number, NIF, email or IBAN first, and by its name otherwise. A statement accepted elsewhere counts as corroboration, and a rejected one isn't suggested again. You only see what the documents you can open say.
