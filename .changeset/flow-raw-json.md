---
"@canopy/drive-vertical": minor
---

A flow can now be read and edited as JSON. In the flow editor, switch from Canvas to Raw JSON to see the flow's name, whether it is on, and its steps and connections, and change them by hand. Saving checks the JSON exactly as the server does and says what is wrong instead of saving it. The flow's id, author and timestamps stay out of the text, and anything like them is ignored. Switch back to Canvas to see your edit drawn.
