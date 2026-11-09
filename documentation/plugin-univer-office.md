# Univer Office

View and edit spreadsheets and documents inline, powered by Univer.

## What it does

Univer Office (loaded from a CDN) opens delimited text — CSV/TSV — as an editable
spreadsheet, and Univer's own JSON snapshots for richer documents. Edits save back to the
file: a CSV saves back as CSV, and a Univer document saves its JSON snapshot. It registers
**Spreadsheet** and **Document** entries in the host's *New* menu. Univer slide snapshots
(`.uslide`) open read-only, since slide editing is still experimental upstream.

Excel and OpenDocument spreadsheets (`.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.ods`) open
**read-only**: SheetJS parses the file and the plugin hands Univer values, formulas, merged
cells, number formats and column widths. Charts, images, macros and cell styling aren't
shown. Plugins can only save text back to the file they opened, so these can't be edited
yet.

## At a glance

- **Type:** File viewer + editor (sandboxed)
- **Handles:** `text/csv`, `.csv`, `.tsv`, Univer snapshots `.usheet`, `.udoc`,
  `.uslide` (read-only), `.univer`, and spreadsheets `.xls`, `.xlsx`, `.xlsm`, `.xlsb`,
  `.ods` (read-only)
- **Capabilities:** `item:read`, `item:write`, `net:fetch` (`unpkg.com`, `cdn.sheetjs.com`)
- **Creates:** "Spreadsheet" (`.csv`) and "Document" (`.udoc`)
- **Availability:** install from the drive's plugin catalog
- **Source:** `examples/plugins/univer-office/`

## See also

- [Markdown Editor](plugin-markdown-editor) — another CDN-loaded editor with offline fallback.
- [Storage and files](storage-and-files) — how saved versions are stored.
