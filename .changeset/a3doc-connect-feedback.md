---
"@canopy/drive-vertical": patch
---

Connecting a3doc no longer fails out of sight. The create dialog keeps its status and errors outside the scrolling form, lets you correct a refused login and try again on the space it just made, and stays open while a login waits for that space. In space settings, Enter in a login field connects, Save space waits until the login is connected or cancelled, and a refusal shows beside the Connect button.

The deploy workflow now also runs for changes under `packages/connectors/`, which the drive bundles.
