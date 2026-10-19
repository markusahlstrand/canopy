// Canopy editor plugin — runs inside a sandboxed, opaque-origin iframe.
//
// Password-protected text files. A `.locked` file holds a small JSON envelope:
// the text encrypted with AES-256-GCM under a key derived from the password with
// PBKDF2-SHA-256. Encryption and decryption happen here, in the browser; the host
// only ever receives the envelope on save, so the drive stores ciphertext and the
// password never leaves this frame. There is no recovery: a lost password means a
// lost file.
//
// A `.locked` file that isn't an envelope yet (an empty upload, or plain text) is
// offered for encryption. Earlier versions in the file's history are not touched,
// so plain text uploaded before encrypting stays readable there.
//
// Contract: export default `render(ctx)` with ctx.{container, file, emit}.
//   ctx.file = { name, mime, bytes: ArrayBuffer, writable: boolean }
//   save:  ctx.emit("save", { content })   → host replies { type:"canopy:save-result", ok, error? }

const FORMAT = "canopy-locked";
const VERSION = 1;
const ITERATIONS = 600000; // OWASP's PBKDF2-SHA-256 recommendation
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 10000000; // a tampered file must not hang the tab
const MIN_PASSWORD = 8;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The parameters are bound to the ciphertext, so editing them breaks decryption. */
const additionalData = (iterations, salt) => enc.encode(`${FORMAT}/v${VERSION}/PBKDF2-SHA-256/${iterations}/${salt}`);

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Returns the envelope, `null` for content that isn't one, or throws for a damaged one. */
function parseEnvelope(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || doc.format !== FORMAT) return null;
  if (doc.v !== VERSION) throw Error(`This file uses ${FORMAT} format v${doc.v}, which this plugin can't read.`);
  const it = doc.kdf?.iterations;
  if (doc.kdf?.name !== "PBKDF2" || doc.kdf?.hash !== "SHA-256" || !Number.isInteger(it) || it < MIN_ITERATIONS || it > MAX_ITERATIONS)
    throw Error("This file's key settings are not supported.");
  if (doc.cipher?.name !== "AES-GCM" || typeof doc.cipher?.iv !== "string" || typeof doc.data !== "string" || typeof doc.kdf.salt !== "string")
    throw Error("This file is damaged.");
  return doc;
}

async function seal(session, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(session.iterations, session.salt) },
    session.key,
    enc.encode(plaintext),
  );
  const envelope = {
    format: FORMAT,
    v: VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: session.iterations, salt: session.salt },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(new Uint8Array(data)),
  };
  return JSON.stringify(envelope, null, 1) + "\n";
}

async function newSession(password) {
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, iterations: ITERATIONS, key: await deriveKey(password, fromBase64(salt), ITERATIONS) };
}

async function open(envelope, password) {
  const { salt, iterations } = envelope.kdf;
  const key = await deriveKey(password, fromBase64(salt), iterations);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.cipher.iv), additionalData: additionalData(iterations, salt) },
    key,
    fromBase64(envelope.data),
  );
  return { session: { salt, iterations, key }, text: dec.decode(plain) };
}

export default function render(ctx) {
  const { container, file } = ctx;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const c = dark
    ? { fg: "#e5e7eb", muted: "#9ca3af", border: "#374151", field: "#111827", warn: "#fbbf24", bad: "#f87171", ok: "#4ade80" }
    : { fg: "#111827", muted: "#6b7280", border: "#d1d5db", field: "#ffffff", warn: "#b45309", bad: "#b91c1c", ok: "#15803d" };
  container.style.cssText = `font:14px system-ui,-apple-system,sans-serif;color:${c.fg}`;

  if (!crypto?.subtle) {
    container.textContent = "Encryption isn't available here — the drive must be served over HTTPS (or localhost).";
    return;
  }

  // Whatever is on disk right now: the envelope text, refreshed after every save.
  let stored = dec.decode(new Uint8Array(file.bytes));
  let session = null; // { key, salt, iterations } while unlocked
  let pending = null; // envelope text sent with the in-flight save

  const el = (tag, style, text) => {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (label, primary) =>
    el(
      "button",
      primary
        ? "border:0;border-radius:7px;padding:7px 14px;font:600 13px system-ui;color:#fff;background:#3F7A55;cursor:pointer"
        : `border:1px solid ${c.border};border-radius:7px;padding:6px 12px;font:13px system-ui;color:inherit;background:transparent;cursor:pointer`,
      label,
    );
  const password = (placeholder, autocomplete) => {
    const input = el(
      "input",
      `width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid ${c.border};border-radius:7px;background:${c.field};color:inherit;font:14px system-ui`,
    );
    input.type = "password";
    input.placeholder = placeholder;
    input.autocomplete = autocomplete;
    return input;
  };
  const note = (text, color) => el("p", `margin:0;font-size:13px;line-height:1.5;color:${color || c.muted}`, text);

  /** A centred card: heading, explanation, fields, action — used by every locked state. */
  function card(title, lines, fields, action, onSubmit) {
    container.replaceChildren();
    const form = el("form", `max-width:380px;margin:48px auto;display:flex;flex-direction:column;gap:12px`);
    form.append(el("div", "font-size:28px", "🔒"), el("div", "font-weight:600;font-size:16px", title));
    for (const line of lines) form.append(note(line[0], line[1]));
    form.append(...fields);
    const error = note("", c.bad);
    form.append(error);
    if (action) form.append(action);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.textContent = "";
      if (action) action.disabled = true;
      try {
        await onSubmit((message) => (error.textContent = message));
      } finally {
        if (action) action.disabled = false;
      }
    });
    container.append(form);
    fields[0]?.focus();
  }

  function showLocked(envelope) {
    const pw = password("Password", "current-password");
    const unlock = button("Unlock", true);
    unlock.type = "submit";
    card(file.name, [["This note is encrypted. Enter its password to read it."]], [pw], unlock, async (fail) => {
      unlock.textContent = "Unlocking…";
      try {
        const opened = await open(envelope, pw.value);
        session = opened.session;
        showEditor(opened.text);
      } catch {
        unlock.textContent = "Unlock";
        pw.select();
        fail("Wrong password, or the file has been damaged.");
      }
    });
  }

  /** New password + confirmation; resolves the pair to `done(password)` once they agree. */
  function choosePassword(title, lines, label, done) {
    const pw = password("New password", "new-password");
    const again = password("Repeat password", "new-password");
    const go = button(label, true);
    go.type = "submit";
    const reminder = [`At least ${MIN_PASSWORD} characters. There is no way to recover a forgotten password.`];
    card(title, [...lines, reminder], [pw, again], go, async (fail) => {
      if (pw.value.length < MIN_PASSWORD) return fail(`Use at least ${MIN_PASSWORD} characters.`);
      if (pw.value !== again.value) return fail("The passwords don't match.");
      go.textContent = "Encrypting…";
      await done(pw.value, fail);
      go.textContent = label;
    });
  }

  function showUnencrypted() {
    if (!file.writable) {
      card(file.name, [["This file isn't encrypted yet, and you can't change it here."]], [], null, () => {});
      return;
    }
    const lines = [["This file isn't encrypted yet. Choose a password to encrypt it."]];
    if (stored.trim())
      lines.push([
        "Its current text will be encrypted. Earlier versions in the file's history stay unencrypted — delete them if they hold secrets.",
        c.warn,
      ]);
    choosePassword(file.name, lines, "Encrypt", async (pw, fail) => {
      session = await newSession(pw);
      const text = stored;
      const ok = await save(await seal(session, text));
      if (ok) showEditor(text);
      else {
        session = null;
        fail("Saving the encrypted file failed.");
      }
    });
  }

  // ── saving: one in flight at a time, resolved by the host's save-result ──────
  let settle = null;
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.type !== "canopy:save-result" || !settle) return;
    if (m.ok) stored = pending;
    const done = settle;
    settle = null;
    done(m.ok ? true : m.error || "unknown error");
  });
  function save(envelope) {
    pending = envelope;
    return new Promise((resolve) => {
      settle = (result) => resolve(result === true);
      ctx.emit("save", { content: envelope });
    });
  }

  function showEditor(text) {
    container.replaceChildren();
    const bar = el("div", "display:flex;align-items:center;gap:8px;padding:2px 2px 10px;flex-wrap:wrap");
    const name = el("div", "font-weight:600;flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", `🔓 ${file.name}`);
    const status = el("span", `font-size:12px;color:${c.muted}`);
    const lock = button("Lock");
    bar.append(name, status);
    const area = el(
      "textarea",
      `width:100%;box-sizing:border-box;min-height:480px;resize:vertical;padding:12px;border:1px solid ${c.border};border-radius:8px;background:transparent;color:inherit;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace`,
    );
    area.value = text;
    area.spellcheck = false;
    area.readOnly = !file.writable;

    let dirty = false;
    let discardArmed = false;
    const setStatus = (t, color) => {
      status.textContent = t;
      status.style.color = color || c.muted;
    };
    area.addEventListener("input", () => {
      dirty = true;
      discardArmed = false;
      setStatus("Unsaved changes", c.warn);
    });

    let saveBtn = null;
    async function doSave() {
      if (!file.writable || !dirty || settle) return;
      saveBtn.disabled = true;
      setStatus("Encrypting and saving…");
      const ok = await save(await seal(session, area.value));
      saveBtn.disabled = false;
      if (ok) {
        dirty = false;
        setStatus("Saved, encrypted ✓", c.ok);
      } else setStatus("Save failed", c.bad);
    }

    if (file.writable) {
      const change = button("Change password");
      change.addEventListener("click", () => {
        if (dirty) return setStatus("Save your changes before changing the password", c.warn);
        const current = area.value;
        choosePassword("Change password", [["The note is re-encrypted with the new password."]], "Change password", async (pw, fail) => {
          const previous = session;
          session = await newSession(pw);
          if (await save(await seal(session, current))) showEditor(current);
          else {
            session = previous;
            fail("Saving with the new password failed — the old password still applies.");
          }
        });
        const cancel = button("Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => showEditor(current));
        container.querySelector("form").append(cancel);
      });
      saveBtn = button("Save", true);
      saveBtn.addEventListener("click", doSave);
      bar.append(lock, change, saveBtn);
    } else {
      bar.append(lock);
      setStatus("Read-only");
    }

    lock.addEventListener("click", () => {
      if (dirty && !discardArmed) {
        discardArmed = true;
        return setStatus("Unsaved changes — click Lock again to discard them", c.bad);
      }
      area.value = "";
      session = null;
      start();
    });
    area.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        doSave();
      }
    });

    container.append(bar, area);
    area.focus();
  }

  function start() {
    let envelope;
    try {
      envelope = parseEnvelope(stored);
    } catch (error) {
      card(file.name, [[error.message, c.bad]], [], null, () => {});
      return;
    }
    if (envelope) showLocked(envelope);
    else showUnencrypted();
  }

  start();
  ctx.emit("loaded", {});
}
