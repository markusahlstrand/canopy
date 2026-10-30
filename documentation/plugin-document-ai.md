# Document AI

Automatically labels and describes each uploaded document using an AI model.

## What it does

When a file is uploaded to a space with Document AI turned on, Canopy queues it. Once the
file's text has been extracted for search, whenever that happens, Canopy asks an AI model what kind of document it is
(invoice, contract, receipt, …). It adds that type as a **label** and, if the file has no
description yet, writes a one- or two-sentence **description**. Both show in the file's
**Details** tab and are searchable.

A description someone wrote is kept, and the AI's label is added next to any labels already
there. What the AI wrote itself is replaced when the file changes: its old label goes, and its
old description is updated unless someone edited it. If someone edits the details while the model is
working, their edit is kept and the AI's additions are merged in. If the file is replaced
with a new version first, Canopy analyses the new version instead. A file is analysed at
most once a day however often it is saved, and the latest version is still analysed when the
day is up. A file without text is tried again only when a new version is uploaded. Encrypted
`.locked` files are never sent.

## Turning it on

Open **Space settings** and tick **Label new uploads automatically**. Only space
administrators can change this. It is off by default, because it sends document text to a
model.

## Limits

- Reads the extracted text, not the file itself. Scans and images without a text layer are
  skipped.
- Reads the first 12,000 characters.
- Runs for browser uploads, WebDAV and the text editor, not for files in connected sources.
- The document's text is untrusted. The model is told not to follow instructions in it, and
  links and mail addresses are removed from what it writes, but a document can still steer
  the wording of its own description.
- Labels are free text chosen by the model, not picked from a fixed list.

## At a glance

- **Where:** built into the drive (`apps/drive-vertical/src/document-ai.ts`), not a separate
  install.
- **Model:** Workers AI through the platform's model host; override with `DOCUMENT_AI_MODEL`.
- **Writes:** `drive/update-file-details`, as the person who uploaded the file.

## See also

- [Storage and files](storage-and-files) — where descriptions and labels live.
