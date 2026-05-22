// Canopy viewer plugin — runs inside a sandboxed, opaque-origin iframe.
//
// A rich Markdown view + editor built on Toast UI Editor (loaded from a CDN).
// The host hands us only this file's bytes; on Save we emit the new markdown and
// the host writes it back to this one file. If the CDN is unreachable we fall
// back to a plain-text editor so editing still works offline.
//
// Contract: export default `render(ctx)` with ctx.{container, file, emit}.
//   ctx.file = { name, mime, bytes: ArrayBuffer, writable: boolean }
//   save:  ctx.emit("save", { content })   → host replies { type:"canopy:save-result", ok, error? }

const ESM = "https://esm.sh/@toast-ui/editor@3";
const CSS = "https://cdn.jsdelivr.net/npm/@toast-ui/editor@3/dist/toastui-editor.css";

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

export default async function render(ctx) {
  const { container, file } = ctx;
  const text = new TextDecoder().decode(new Uint8Array(file.bytes));
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;

  // ── toolbar: filename · status · Save ──────────────────────────────────────
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
  if (file.writable) container.appendChild(bar);

  const host = document.createElement("div");
  container.appendChild(host);

  let dirty = false;
  const setStatus = (t, c) => {
    statusEl.textContent = t;
    statusEl.style.color = c || "#6b7280";
  };
  const markDirty = () => {
    if (!dirty) {
      dirty = true;
      setStatus("Unsaved changes", "#b45309");
    }
  };

  // `getContent` is rebound depending on which editor we end up mounting.
  let getContent = () => text;

  try {
    await injectCss(CSS);
    const mod = await import(ESM);
    const Editor = mod.default || mod.Editor;
    const editor = new Editor({
      el: host,
      height: "520px",
      initialValue: text,
      initialEditType: "wysiwyg",
      previewStyle: "vertical",
      usageStatistics: false,
      theme: dark ? "dark" : "light",
    });
    getContent = () => editor.getMarkdown();
    // Attach the change listener next frame so the initial value doesn't mark dirty.
    requestAnimationFrame(() => editor.on("change", markDirty));
  } catch {
    // Offline / CDN blocked → plain textarea editor (still fully editable + saveable).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.spellcheck = false;
    ta.style.cssText =
      "width:100%;box-sizing:border-box;min-height:480px;resize:vertical;padding:12px;border:1px solid #d1d5db;border-radius:8px;background:transparent;color:inherit;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace";
    host.appendChild(ta);
    getContent = () => ta.value;
    ta.addEventListener("input", markDirty);
    setStatus("Rich editor offline — editing as plain text");
  }

  function doSave() {
    if (!file.writable || !dirty) return;
    saveBtn.disabled = true;
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
    saveBtn.disabled = false;
    if (m.ok) {
      dirty = false;
      setStatus("Saved ✓", "#15803d");
    } else {
      setStatus("Save failed: " + (m.error || "unknown error"), "#b91c1c");
    }
  });
}
