// Canopy viewer plugin: renders an .eml (RFC 5322) message as a readable email.
//
// Runs inside a sandboxed, opaque-origin iframe. The host hands us only this file's
// bytes. We parse them with postal-mime (pure JS, loaded from a CDN), then show:
//   - a header card (From, To, Cc, Subject, Date)
//   - the attachments by name, type and size
//   - the body: plain text by default. If the message also has an HTML part, a toggle
//     shows it. An HTML-only message shows the HTML straight away.
//
// The HTML body goes into a nested iframe with an empty `sandbox` (no scripts, no
// forms, no popups) and its own CSP that blocks every remote load, so tracking pixels
// and remote images never fire. Inline `cid:` images are swapped for data: URLs taken
// from the message itself.
//
// If the parser can't load (offline, CDN blocked) or can't parse the bytes, we show the
// raw message text, so the user still sees something.
//
// Ported from vault's renderEmailAsHtml.
//
// Contract: export default `render(ctx)` with ctx.{container, file, emit}.

const POSTAL_MIME = "https://cdn.jsdelivr.net/npm/postal-mime@4.2.1/+esm";

const CSS = `
  :root { color-scheme: light dark;
    --fg:#1d1d1f; --muted:#6e6e73; --bg:transparent; --card:#ffffff; --border:#e5e5ea;
    --chip:#f2f2f5; --accent:#3F7A55; --warn:#b00020; }
  @media (prefers-color-scheme: dark) { :root {
    --fg:#e8e8ed; --muted:#a1a1a6; --card:#1c1c1e; --border:#38383a;
    --chip:#2c2c2e; --accent:#7fbf95; --warn:#ff6b6b; } }
  html, body { margin:0; height:100%; background:var(--bg); }
  #root { height:100%; }
  .eml { box-sizing:border-box; height:100%; display:flex; flex-direction:column; gap:12px;
    padding:16px 20px; color:var(--fg); line-height:1.45;
    font:14px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  .eml h1 { margin:0; font-size:1.15rem; font-weight:600; word-break:break-word; }
  .headers { margin:0; padding:10px 14px; background:var(--card); border:1px solid var(--border);
    border-radius:8px; display:grid; grid-template-columns:max-content 1fr; gap:4px 14px; }
  .headers dt { color:var(--muted); font-size:.82em; padding-top:1px; }
  .headers dd { margin:0; font-size:.92em; word-break:break-word; }
  .atts { display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:.85em; }
  .atts .label { color:var(--muted); margin-right:2px; }
  .chip { background:var(--chip); border:1px solid var(--border); border-radius:999px;
    padding:2px 10px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip small { color:var(--muted); margin-left:4px; }
  .bar { display:flex; gap:8px; align-items:center; font-size:.82em; color:var(--muted); }
  .bar button { font:inherit; color:var(--accent); background:none; border:1px solid var(--border);
    border-radius:6px; padding:2px 10px; cursor:pointer; }
  .body { flex:1; min-height:320px; display:flex; }
  pre.text { flex:1; margin:0; padding:14px 16px; background:var(--card); border:1px solid var(--border);
    border-radius:8px; white-space:pre-wrap; word-break:break-word; overflow:auto;
    font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  iframe.html { flex:1; width:100%; border:1px solid var(--border); border-radius:8px; background:#fff; }
  .note { color:var(--warn); font-size:.85em; margin:0; }
  .empty { color:var(--muted); font-style:italic; margin:0; }
`;

export default async function render(ctx) {
  const { container, file } = ctx;
  injectStyles(container);
  const bytes = new Uint8Array(file.bytes);

  let email;
  try {
    const mod = await import(POSTAL_MIME);
    const PostalMime = mod.default || mod.PostalMime;
    email = await PostalMime.parse(bytes, { attachmentEncoding: "arraybuffer" });
  } catch (err) {
    renderRaw(container, bytes, err);
    ctx.emit("error", { name: file.name, message: errorMessage(err) });
    return;
  }

  renderEmail(container, email);
  ctx.emit("loaded", {
    name: file.name,
    subject: email.subject || null,
    attachments: (email.attachments || []).length,
  });
}

function renderEmail(container, email) {
  const root = el("div", "eml");

  root.append(el("h1", null, email.subject || "(no subject)"));

  const dl = el("dl", "headers");
  const row = (label, value) => {
    if (!value) return;
    dl.append(el("dt", null, label), el("dd", null, value));
  };
  row("From", formatAddresses(email.from ? [email.from] : []));
  row("Reply-To", formatAddresses(email.replyTo));
  row("To", formatAddresses(email.to));
  row("Cc", formatAddresses(email.cc));
  row("Date", formatDate(email.date));
  root.append(dl);

  // Inline images referenced from the HTML (cid:) are part of the body, not attachments
  // the user cares about. Everything else is listed.
  const attachments = email.attachments || [];
  const listed = attachments.filter((a) => !(a.related && a.contentId));
  if (listed.length) {
    const atts = el("div", "atts");
    atts.append(el("span", "label", `${listed.length} attachment${listed.length === 1 ? "" : "s"}:`));
    for (const a of listed) {
      const chip = el("span", "chip", a.filename || "(unnamed)");
      chip.title = `${a.filename || "(unnamed)"} · ${a.mimeType}`;
      const size = byteLength(a.content);
      chip.append(el("small", null, size != null ? formatSize(size) : a.mimeType));
      atts.append(chip);
    }
    root.append(atts);
  }

  const text = (email.text || "").trim() ? email.text : "";
  const html = (email.html || "").trim() ? email.html : "";
  const body = el("div", "body");

  if (text && html) {
    const bar = el("div", "bar");
    const toggle = el("button", null, "Show formatted");
    toggle.type = "button";
    let showingHtml = false;
    toggle.addEventListener("click", () => {
      showingHtml = !showingHtml;
      toggle.textContent = showingHtml ? "Show plain text" : "Show formatted";
      body.replaceChildren(showingHtml ? htmlFrame(html, attachments) : textBlock(text));
    });
    bar.append(el("span", null, "Plain text"), toggle);
    root.append(bar);
    body.append(textBlock(text));
  } else if (html) {
    body.append(htmlFrame(html, attachments));
  } else if (text) {
    body.append(textBlock(text));
  } else {
    body.append(el("p", "empty", "This message has no body."));
  }
  root.append(body);

  if (html) root.append(el("p", "empty", "Remote images and scripts in this email are blocked."));

  container.append(root);
}

function textBlock(text) {
  return el("pre", "text", text);
}

/** HTML body in a script-less, network-less nested frame. */
function htmlFrame(html, attachments) {
  const inline = new Map();
  for (const a of attachments) {
    if (!a.contentId || !a.mimeType.startsWith("image/")) continue;
    const id = a.contentId.replace(/^<|>$/g, "").trim().toLowerCase();
    const b64 = toBase64(a.content);
    if (b64 != null) inline.set(id, `data:${a.mimeType};base64,${b64}`);
  }
  const withImages = html.replace(/cid:([^"'\s)>]+)/gi, (match, id) => {
    let key = id;
    try { key = decodeURIComponent(id); } catch { /* keep as is */ }
    return inline.get(key.trim().toLowerCase()) || match;
  });

  const frame = document.createElement("iframe");
  frame.className = "html";
  frame.title = "Email body";
  // Empty sandbox: no scripts, forms, popups, top navigation or same-origin access.
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc =
    `<!doctype html><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">` +
    `<base target="_blank">` +
    `<style>body{margin:12px 16px;font:14px -apple-system,system-ui,sans-serif;color:#1d1d1f;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style>` +
    withImages;
  return frame;
}

function renderRaw(container, bytes, err) {
  const root = el("div", "eml");
  root.append(
    el(
      "p",
      "note",
      `Couldn't parse this email (${errorMessage(err)}). Showing the raw message instead.`,
    ),
  );
  const body = el("div", "body");
  body.append(textBlock(new TextDecoder().decode(bytes)));
  root.append(body);
  container.append(root);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function injectStyles(container) {
  const style = document.createElement("style");
  style.textContent = CSS;
  (container.ownerDocument.head || container.ownerDocument.documentElement).append(style);
}

/** Build an element; text is always set as textContent, never parsed as HTML. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatMailbox(m) {
  if (!m) return "";
  if (m.group) {
    const members = m.group.map(formatMailbox).filter(Boolean).join(", ");
    return m.name ? `${m.name}: ${members}` : members;
  }
  if (m.name && m.address) return `${m.name} <${m.address}>`;
  return m.address || m.name || "";
}

function formatAddresses(list) {
  if (!list || !list.length) return "";
  return list.map(formatMailbox).filter(Boolean).join(", ");
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function byteLength(content) {
  if (content instanceof ArrayBuffer) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  return null;
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function toBase64(content) {
  let bytes;
  if (content instanceof ArrayBuffer) bytes = new Uint8Array(content);
  else if (ArrayBuffer.isView(content)) bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  else return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function errorMessage(err) {
  return String((err && err.message) || err);
}
