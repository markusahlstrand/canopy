# Univer Office

View and edit spreadsheets and documents inline, powered by Univer.

## What it does

Univer Office (loaded from a CDN) opens delimited text — CSV/TSV — as an editable
spreadsheet, and Univer's own JSON snapshots for richer documents. Edits save back to the
file: a CSV saves back as CSV, and a Univer document saves its JSON snapshot. It registers
**Spreadsheet** and **Document** entries in the host's *New* menu. Univer slide snapshots
(`.uslide`) open read-only, since slide editing is still experimental upstream.

## At a glance

- **Type:** File viewer + editor (sandboxed)
- **Handles:** `text/csv`, `.csv`, `.tsv`, and Univer snapshots `.usheet`, `.udoc`,
  `.uslide` (read-only), `.univer`
- **Capabilities:** `item:read`, `item:write`
- **Creates:** "Spreadsheet" (`.csv`) and "Document" (`.udoc`)
- **Availability:** built-in — always available, not in the store
- **Source:** `examples/plugins/univer-office/`

## See also

- [Markdown Editor](plugin-markdown-editor) — another CDN-loaded editor with offline fallback.
- [Storage and files](storage-and-files) — how saved versions are stored.
