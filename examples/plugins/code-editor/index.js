// Canopy viewer plugin — runs inside a sandboxed, opaque-origin iframe.
//
// A code editor built on Monaco — the same editor that powers VS Code — loaded
// from a CDN. The host hands us only this file's bytes; on Save we emit the new
// source and the host writes it back to this one file. If the CDN is unreachable
// we fall back to a plain monospace textarea so editing still works offline.
//
// Monaco needs language-service web workers. We run inside an *opaque-origin*
// frame, so workers are bootstrapped from a same-origin blob that `importScripts`
// the cross-origin worker bundle — the standard CDN-Monaco pattern.
//
// Contract: export default `render(ctx)` with ctx.{container, file, emit}.
//   ctx.file = { name, mime, bytes: ArrayBuffer, writable: boolean }
//   save:  ctx.emit("save", { content })   → host replies { type:"canopy:save-result", ok, error? }

const VERSION = "0.52.2";
const BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${VERSION}/min/`;
const VS = `${BASE}vs`;

// Map a file extension / name to a Monaco language id. Unknown → "plaintext".
function languageFor(name) {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  const map = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    json: "json", jsonc: "json",
    html: "html", htm: "html", vue: "html", svelte: "html",
    css: "css", scss: "scss", less: "less",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c", h: "c",
    cpp: "cpp", cc: "cpp", hpp: "cpp",
    cs: "csharp",
    php: "php",
    swift: "swift",
    kt: "kotlin", kts: "kotlin",
    sh: "shell", bash: "shell", zsh: "shell",
    sql: "sql",
    yaml: "yaml", yml: "yaml",
    toml: "ini", ini: "ini", env: "ini",
    xml: "xml",
    lua: "lua",
    r: "r",
    pl: "perl",
    graphql: "graphql",
    proto: "proto",
  };
  return map[ext] || "plaintext";
}

// Load the AMD loader (defines a global `require`) via a <script> tag once.
function loadAmdLoader() {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${VS}/loader.js`;
    s.onload = resolve;
    s.onerror = () => reject(new Error("failed to load Monaco loader"));
    document.head.appendChild(s);
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
  host.style.cssText =
    "height:520px;border:1px solid " + (dark ? "#30363d" : "#d1d5db") + ";border-radius:8px;overflow:hidden";
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
    // Workers run from a same-origin blob that pulls in Monaco's worker bundle;
    // required because our frame's origin is opaque (cross-origin to the CDN).
    self.MonacoEnvironment = {
      getWorkerUrl() {
        const src = `self.MonacoEnvironment={baseUrl:"${BASE}"};importScripts("${VS}/base/worker/workerMain.js");`;
        return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      },
    };

    await loadAmdLoader();
    require.config({ paths: { vs: VS } });
    const monaco = await new Promise((resolve, reject) => {
      // eslint-disable-next-line no-undef
      require(["vs/editor/editor.main"], () => resolve(self.monaco), reject);
    });

    const editor = monaco.editor.create(host, {
      value: text,
      language: languageFor(file.name),
      theme: dark ? "vs-dark" : "vs",
      readOnly: !file.writable,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
    });
    getContent = () => editor.getValue();
    // Setting `value` at creation doesn't fire a change, so any edit is real.
    requestAnimationFrame(() => editor.onDidChangeModelContent(markDirty));
  } catch {
    // Offline / CDN blocked → plain textarea (still fully editable + saveable).
    host.style.height = "auto";
    host.style.border = "0";
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.spellcheck = false;
    ta.readOnly = !file.writable;
    ta.style.cssText =
      "width:100%;box-sizing:border-box;min-height:480px;resize:vertical;padding:12px;border:1px solid #d1d5db;border-radius:8px;background:transparent;color:inherit;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace";
    host.appendChild(ta);
    getContent = () => ta.value;
    ta.addEventListener("input", markDirty);
    setStatus("Code editor offline — editing as plain text");
  }

  ctx.emit("loaded", { name: file.name, language: languageFor(file.name) });

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
