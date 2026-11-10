---
"@canopy/scope-drive": minor
"@canopy/drive-vertical": minor
---

A space can get an email address to forward mail to, such as supplier invoices (#357). Space settings → **Email to this space** gets an address from the platform's inbound mail (`mail+…@in.substrat.run`), with a copy button, an allowlist of who may send (it starts with your own address), a new-address button and turn off. Only people who manage the space see it, and a space that mirrors a connected source can't have one.

Each forwarded message lands in `Mail/` as its own folder, named by date and subject. The folder holds `message.eml` and each attachment as an ordinary file, so search, previews and the offline copy pick them up. A message delivered twice is filed once.

`message.eml` needs a Substrat contracts release that carries the original message (the `raw` mail-in change). Until the drive is on that release, only the attachments are filed.
