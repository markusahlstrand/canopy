// Canopy viewer plugin — runs inside a sandboxed, opaque-origin iframe.
//
// A spreadsheet + document editor built on Univer (https://univer.ai), loaded
// from a CDN as UMD bundles. The host hands us only this file's bytes; on Save
// we emit the new content and the host writes it back to this one file.
//
// What each file type maps to:
//   .csv / .tsv ........... Univer spreadsheet; saves back as delimited text (round-trips).
//   .usheet / workbook .... Univer spreadsheet from a native snapshot; saves the JSON snapshot.
//   .udoc / document ...... Univer document from a native snapshot; saves the JSON snapshot.
//   .uslide / slides ...... read-only outline of the snapshot (slide editing is experimental upstream).
//   .univer ............... auto-detected from the JSON shape (workbook / document / slides).
//   .xls/.xlsx/.xlsm/.xlsb/.ods  read-only spreadsheet, parsed by SheetJS (the host can only save text back).
//
// If the CDN is unreachable we fall back to a plain-text editor on the raw bytes
// so the file is still editable + saveable offline (Excel files are binary, so
// those show a message instead).
//
// Contract: export default `render(ctx)` with ctx.{container, file, emit}.
//   ctx.file = { name, mime, bytes: ArrayBuffer, writable: boolean }
//   save:  ctx.emit("save", { content })  → host replies { type:"canopy:save-result", ok, error? }

// Peer globals (pinned, as Univer's own CDN quickstart does) + Univer packages.
// Univer is pinned to 0.25.1 because 1.x no longer publishes the lib/umd bundles
// this plugin loads; moving past it means loading Univer as ES modules instead.
const UNIVER = "0.25.1";
const PEERS = [
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js",
  "https://unpkg.com/rxjs/dist/bundles/rxjs.umd.min.js",
];
const PRESETS = `https://unpkg.com/@univerjs/presets@${UNIVER}/lib/umd/index.js`;
const SHEET = {
  echarts: "https://unpkg.com/echarts@5.6.0/dist/echarts.min.js",
  js: `https://unpkg.com/@univerjs/preset-sheets-core@${UNIVER}/lib/umd/index.js`,
  locale: `https://unpkg.com/@univerjs/preset-sheets-core@${UNIVER}/lib/umd/locales/en-US.js`,
  css: `https://unpkg.com/@univerjs/preset-sheets-core@${UNIVER}/lib/index.css`,
};
// Same SheetJS version as packages/docworker; the npm registry's 0.18.5 has known
// parser CVEs. The "full" build carries the codepages legacy .xls files need.
const SHEETJS = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
const DOC = {
  js: `https://unpkg.com/@univerjs/preset-docs-core@${UNIVER}/lib/umd/index.js`,
  locale: `https://unpkg.com/@univerjs/preset-docs-core@${UNIVER}/lib/umd/locales/en-US.js`,
  css: `https://unpkg.com/@univerjs/preset-docs-core@${UNIVER}/lib/index.css`,
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}
function injectCss(href) {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = resolve;
    link.onerror = resolve; // styling only — never block the editor on CSS
    document.head.appendChild(link);
  });
}
// Scripts must run in order (react → react-dom → presets → preset → locale).
async function loadInOrder(urls) {
  for (const u of urls) await loadScript(u);
}

// ── delimited text ↔ rows ────────────────────────────────────────────────────
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function toDelimited(values, delim) {
  const needsQuote = new RegExp('["\\n\\r' + (delim === "\t" ? "\\t" : ",") + "]");
  return values
    .map((r) =>
      r
        .map((cell) => {
          const s = cell == null ? "" : String(cell);
          return needsQuote.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(delim),
    )
    .join("\n");
}
function workbookFromRows(rows, name) {
  const cellData = {};
  rows.forEach((r, ri) => {
    const cells = {};
    r.forEach((c, ci) => (cells[ci] = { v: c }));
    cellData[ri] = cells;
  });
  return {
    id: "csv-import",
    sheetOrder: ["sheet1"],
    sheets: { sheet1: { id: "sheet1", name: name.replace(/\.[^.]+$/, "") || "Sheet1", cellData } },
  };
}

// ── SheetJS workbook → Univer snapshot ───────────────────────────────────────
// Univer's CellValueType: 1 string, 2 number, 3 boolean.
function univerCell(cell) {
  const out = {};
  if (cell.t === "n") Object.assign(out, { v: cell.v, t: 2 });
  else if (cell.t === "s" || cell.t === "str") Object.assign(out, { v: cell.v, t: 1 });
  else if (cell.t === "b") Object.assign(out, { v: cell.v ? 1 : 0, t: 3 });
  else if (cell.t === "e") Object.assign(out, { v: cell.w || "#ERROR!", t: 1 });
  if (cell.f) out.f = "=" + cell.f;
  // Dates are numbers in a date format, so this is also what makes them read as dates.
  if (cell.t === "n" && cell.z && cell.z !== "General") out.s = { n: { pattern: cell.z } };
  return Object.keys(out).length ? out : null;
}
function a1(ref) {
  const m = /^([A-Z]+)([0-9]+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return { row: Number(m[2]) - 1, col: col - 1 };
}
export function workbookFromSheetJS(wb) {
  const sheets = {};
  const sheetOrder = wb.SheetNames.map((name, index) => {
    const ws = wb.Sheets[name] || {};
    const id = "sheet" + (index + 1);
    const merges = ws["!merges"] || [];
    const cellData = {};
    let lastRow = 0;
    let lastCol = 0;
    for (const ref of Object.keys(ws)) {
      const at = a1(ref);
      const cell = at && univerCell(ws[ref]);
      if (!cell) continue;
      (cellData[at.row] = cellData[at.row] || {})[at.col] = cell;
      lastRow = Math.max(lastRow, at.row);
      lastCol = Math.max(lastCol, at.col);
    }
    for (const m of merges) {
      lastRow = Math.max(lastRow, m.e.r);
      lastCol = Math.max(lastCol, m.e.c);
    }
    const columnData = {};
    (ws["!cols"] || []).forEach((col, i) => {
      if (col && col.wpx) columnData[i] = { w: col.wpx };
    });
    sheets[id] = {
      id,
      name,
      cellData,
      columnData,
      // Univer drops anything past its default grid, so size it to the data.
      rowCount: Math.max(lastRow + 1, 100),
      columnCount: Math.max(lastCol + 1, 26),
      mergeData: merges.map((m) => ({ startRow: m.s.r, endRow: m.e.r, startColumn: m.s.c, endColumn: m.e.c })),
      hidden: wb.Workbook && wb.Workbook.Sheets && wb.Workbook.Sheets[index] && wb.Workbook.Sheets[index].Hidden ? 1 : 0,
    };
    return id;
  });
  return { id: "excel-import", sheetOrder, sheets };
}

// ── decide what this file is ─────────────────────────────────────────────────
// Returns "sheet-csv" | "sheet-excel" | "sheet" | "doc" | "slide". `snapshot` is the
// parsed JSON for the snapshot kinds, `delim` the separator for the csv kind.
function classify(name, text, mime) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (/^(xls|xlsx|xlsm|xlsb|ods)$/.test(ext) || /spreadsheetml|ms-excel|opendocument\.spreadsheet/i.test(mime || ""))
    return { kind: "sheet-excel" };
  if (ext === "csv" || ext === "tsv") return { kind: "sheet-csv", delim: ext === "tsv" ? "\t" : "," };
  let snapshot = null;
  try {
    snapshot = JSON.parse(text);
  } catch {
    /* not JSON — handled by callers as a parse failure */
  }
  if (ext === "usheet") return { kind: "sheet", snapshot };
  if (ext === "udoc") return { kind: "doc", snapshot };
  if (ext === "uslide") return { kind: "slide", snapshot };
  // .univer (generic) — sniff the shape.
  if (snapshot && (snapshot.sheetOrder || snapshot.sheets)) return { kind: "sheet", snapshot };
  if (snapshot && (snapshot.pages || snapshot.pageOrder || snapshot.slides)) return { kind: "slide", snapshot };
  if (snapshot && (snapshot.body || snapshot.documentStyle)) return { kind: "doc", snapshot };
  return { kind: "sheet", snapshot }; // last resort: try a sheet
}

// Pull whatever readable strings we can out of a slide snapshot, for the
// read-only outline. Defensive: works on any shape Univer hands us.
function slideText(node, out, depth) {
  if (depth > 6 || node == null) return;
  if (typeof node === "string") {
    const t = node.trim();
    if (t && t.length > 1 && !/^[#0-9a-f-]{6,}$/i.test(t)) out.push(t);
    return;
  }
  if (Array.isArray(node)) return node.forEach((n) => slideText(n, out, depth + 1));
  if (typeof node === "object") for (const k in node) slideText(node[k], out, depth + 1);
}

export default async function render(ctx) {
  const { container, file } = ctx;
  const text = new TextDecoder().decode(new Uint8Array(file.bytes));
  const info = classify(file.name, text, file.mime);
  const isExcel = info.kind === "sheet-excel";

  // ── toolbar: filename · status · Save ───────────────────────────────────────
  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;gap:10px;padding:2px 2px 10px;font:13px system-ui,-apple-system,sans-serif";
  const nameEl = document.createElement("div");
  nameEl.textContent = file.name;
  nameEl.style.cssText = "font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const statusEl = document.createElement("span");
  statusEl.style.cssText = "font-size:12px;color:#6b7280";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.style.cssText =
    "border:0;border-radius:7px;padding:6px 14px;font:600 13px system-ui;color:#fff;background:#3F7A55;cursor:pointer";
  bar.append(nameEl, statusEl, saveBtn);

  const setStatus = (t, c) => {
    statusEl.textContent = t;
    statusEl.style.color = c || "#6b7280";
  };

  // Save is only actionable when there are unsaved changes. Disable it until the
  // file goes dirty, and grey it out so the state reads clearly.
  const setSaveEnabled = (on) => {
    saveBtn.disabled = !on;
    saveBtn.style.opacity = on ? "1" : "0.5";
    saveBtn.style.cursor = on ? "pointer" : "default";
  };
  setSaveEnabled(false);

  // Slides are read-only (no open-source slide editor exists yet) — render an
  // outline and bail out before any of the editor/save plumbing.
  if (info.kind === "slide") {
    saveBtn.remove(); // read-only — no save affordance
    container.appendChild(bar);
    const banner = document.createElement("div");
    banner.textContent = "Slides are experimental — showing a read-only outline. Slide editing isn't available yet.";
    banner.style.cssText =
      "padding:8px 12px;margin-bottom:12px;border-radius:8px;background:#fef3c7;color:#92400e;font:13px system-ui,-apple-system,sans-serif";
    container.appendChild(banner);
    const pages = info.snapshot && (info.snapshot.pages || info.snapshot.slides);
    const list = pages && typeof pages === "object" ? Object.values(pages) : [];
    if (!list.length) {
      const raw = document.createElement("pre");
      raw.textContent = text.slice(0, 4000);
      raw.style.cssText =
        "white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Menlo,monospace;color:#374151";
      container.appendChild(raw);
    } else {
      list.forEach((page, i) => {
        const card = document.createElement("div");
        card.style.cssText = "padding:12px 14px;margin-bottom:10px;border:1px solid #e5e7eb;border-radius:10px";
        const h = document.createElement("div");
        h.textContent = "Slide " + (i + 1);
        h.style.cssText = "font:600 13px system-ui;margin-bottom:6px;color:#111827";
        card.appendChild(h);
        const texts = [];
        slideText(page, texts, 0);
        const body = document.createElement("div");
        body.textContent = texts.length ? texts.join("  ·  ") : "(no text content)";
        body.style.cssText = "font:13px/1.5 system-ui;color:#374151";
        card.appendChild(body);
        container.appendChild(card);
      });
    }
    ctx.emit("loaded", { kind: "slide", pages: list.length });
    return;
  }

  if (isExcel) {
    saveBtn.remove(); // read-only — no save affordance
    container.appendChild(bar);
    const banner = document.createElement("div");
    banner.textContent = "Read-only preview — Excel files can't be edited or saved here yet.";
    banner.style.cssText =
      "padding:8px 12px;margin-bottom:12px;border-radius:8px;background:#fef3c7;color:#92400e;font:13px system-ui,-apple-system,sans-serif";
    container.appendChild(banner);
    // Typing in Univer's own inputs (find, zoom) isn't a change to this file: keep
    // the host from warning about unsaved edits that can never be saved.
    document.documentElement.setAttribute("data-canopy-transient", "");
  } else if (file.writable) container.appendChild(bar);
  const host = document.createElement("div");
  host.id = "univer-host";
  host.style.cssText = "width:100%;height:640px;position:relative";
  container.appendChild(host);

  let dirty = false;
  const markDirty = () => {
    if (!dirty) {
      dirty = true;
      setStatus("Unsaved changes", "#b45309");
      setSaveEnabled(true);
    }
  };

  // `getContent` is rebound once we know which editor mounted.
  let getContent = () => text;

  try {
    if (info.kind === "doc") {
      await injectCss(DOC.css);
      await loadInOrder([...PEERS, PRESETS, DOC.js, DOC.locale]);
      const { createUniver } = UniverPresets;
      const { LocaleType, mergeLocales } = UniverCore;
      const { UniverDocsCorePreset } = UniverPresetDocsCore;
      const theme = typeof UniverDesign !== "undefined" ? UniverDesign.defaultTheme : undefined;
      const { univerAPI } = createUniver({
        locale: LocaleType.EN_US,
        locales: { [LocaleType.EN_US]: mergeLocales(UniverPresetDocsCoreEnUS) },
        theme,
        presets: [UniverDocsCorePreset({ container: "univer-host" })],
      });
      univerAPI.createUniverDoc(info.snapshot || {});
      getContent = () => {
        const doc = univerAPI.getActiveDocument && univerAPI.getActiveDocument();
        const snap = doc && (doc.save ? doc.save() : doc.getSnapshot ? doc.getSnapshot() : null);
        if (!snap) {
          setStatus("Couldn't read document changes — saving original", "#b45309");
          return text;
        }
        return JSON.stringify(snap, null, 2);
      };
      attachDirtyWatcher(univerAPI, markDirty);
    } else {
      // sheet or sheet-csv
      await injectCss(SHEET.css);
      await loadInOrder([...PEERS, SHEET.echarts, PRESETS, SHEET.js, SHEET.locale, ...(isExcel ? [SHEETJS] : [])]);
      const { createUniver } = UniverPresets;
      const { LocaleType, mergeLocales } = UniverCore;
      const { UniverSheetsCorePreset } = UniverPresetSheetsCore;
      const theme = typeof UniverDesign !== "undefined" ? UniverDesign.defaultTheme : undefined;
      const { univerAPI } = createUniver({
        locale: LocaleType.EN_US,
        locales: { [LocaleType.EN_US]: mergeLocales(UniverPresetSheetsCoreEnUS) },
        theme,
        presets: [UniverSheetsCorePreset({ container: "univer-host" })],
      });
      const data = isExcel
        ? workbookFromSheetJS(XLSX.read(new Uint8Array(file.bytes), { type: "array", cellNF: true, cellStyles: true }))
        : info.kind === "sheet-csv"
          ? workbookFromRows(parseDelimited(text, info.delim), file.name)
          : info.snapshot || { id: "workbook" };
      const create = univerAPI.createWorkbook || univerAPI.createUniverSheet;
      create.call(univerAPI, data);
      getContent = () => {
        const wb = univerAPI.getActiveWorkbook();
        if (info.kind === "sheet-csv") {
          const values = wb.getActiveSheet().getDataRange().getValues();
          return toDelimited(values, info.delim);
        }
        return JSON.stringify(wb.save(), null, 2);
      };
      if (isExcel) {
        await univerAPI.getActiveWorkbook().getWorkbookPermission().setReadOnly();
      } else attachDirtyWatcher(univerAPI, markDirty);
    }
  } catch (err) {
    if (isExcel) {
      // Binary: a text editor on these bytes would be garbage, and saving it would corrupt the file.
      host.style.height = "auto";
      host.textContent = "Couldn't open this spreadsheet: " + (err && err.message ? err.message : err);
      host.style.font = "13px system-ui,-apple-system,sans-serif";
      ctx.emit("loaded", { kind: info.kind, error: true });
      return;
    }
    // Offline / CDN blocked → plain textarea editor on the raw bytes.
    host.style.height = "auto";
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.spellcheck = false;
    ta.style.cssText =
      "width:100%;box-sizing:border-box;min-height:480px;resize:vertical;padding:12px;border:1px solid #d1d5db;border-radius:8px;background:transparent;color:inherit;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace";
    host.appendChild(ta);
    getContent = () => ta.value;
    ta.addEventListener("input", markDirty);
    setStatus("Univer offline — editing raw " + (info.kind === "doc" ? "document" : "data") + " as text");
  }

  function doSave() {
    if (!file.writable || !dirty) return;
    setSaveEnabled(false);
    setStatus("Saving…");
    ctx.emit("save", { content: getContent() });
  }
  saveBtn.addEventListener("click", doSave);
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      doSave();
    }
  });
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.type !== "canopy:save-result") return;
    if (m.ok) {
      dirty = false;
      setSaveEnabled(false); // saved → nothing to save until the next edit
      setStatus("Saved ✓", "#15803d");
    } else {
      setSaveEnabled(true); // changes are still pending — let the user retry
      setStatus("Save failed: " + (m.error || "unknown error"), "#b91c1c");
    }
  });

  ctx.emit("loaded", { kind: info.kind });
}

// Mark the file dirty on the first edit command. Attached late so the commands
// Univer fires while loading the initial content don't flag a pristine file.
function attachDirtyWatcher(univerAPI, markDirty) {
  if (typeof univerAPI.onCommandExecuted !== "function") return;
  setTimeout(() => {
    univerAPI.onCommandExecuted((command) => {
      if (command && command.type === 2 /* MUTATION */) markDirty();
    });
  }, 800);
}
