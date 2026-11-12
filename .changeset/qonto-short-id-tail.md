---
"@canopy/connector-qonto": patch
---

Qonto items made within the same minute no longer share a name: the short id in a file name is now the random tail of Qonto's time-ordered id, not its timestamp head, so a sync no longer fails with "source file name is occupied". Files already landed keep their names.
