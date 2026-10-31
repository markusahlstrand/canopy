---
"@canopy/drive-vertical": patch
---

Add `spec/concept.md` for the drive vertical: the drive described from the code as it stands, with generated roles, entity and process sections kept in sync by `substrat concept sync`. It records four decisions to follow Substrat standard where the drive departs from it: K-45 trash with a 30-day purge, a `drive:manage-spaces` key for creating spaces, retiring the duplicate `member` role into `viewer`, and correcting the `provision.ts` header. No behaviour changes.
