---
"@canopy/drive-vertical": patch
---

An a3doc space starts its first sync as soon as it connects, instead of waiting up to 15 minutes for the platform's next pass. Space settings → Source gets a **Sync now** button, which says what the sync did, and the panel follows the first sync until it finishes. A change pushed while a sync lands items now re-reads the open folder quietly, at most every 3 seconds. An empty folder no longer flickers between the loading skeleton and its empty state every couple of seconds.
