---
"@canopy/drive-vertical": minor
"@canopy/ui": patch
---

New **Email Viewer** plugin in the catalog for `.eml` files, such as the `message.eml` that email-to-a-space files under `Mail/`. It shows the sender, recipients, subject and date, lists the attachments, and shows the plain-text body, with a button to switch to the formatted version. HTML-only messages show formatted straight away. The formatted body runs without scripts and never loads remote images, so tracking pixels don't fire; inline images that come with the message still show. The parser (postal-mime) loads from a CDN, and without it the viewer shows the raw message. `@canopy/ui` gains a `mail` icon.
