/**
 * AES-GCM string encryption for secrets stored at rest (e.g. a plugin's GitHub
 * token in `plugin_settings`). Same construction as the session cookie: a key
 * derived from a server secret (SESSION_SECRET), random 12-byte IV prepended to
 * the ciphertext, base64url-encoded. The secret value is never returned to the
 * client and never logged.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function keyFromSecret(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptString(secret: string, plaintext: string): Promise<string> {
  const key = await keyFromSecret(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64urlEncode(out);
}

export async function decryptString(secret: string, token: string): Promise<string | null> {
  try {
    const raw = b64urlDecode(token);
    const iv = raw.slice(0, 12);
    const ct = raw.slice(12);
    const key = await keyFromSecret(secret);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return decoder.decode(pt);
  } catch {
    return null;
  }
}

/**
 * Resolve a plugin's stored settings JSON into a usable config: secret fields are
 * decrypted with `secret`, everything else passes through. Shared by the request
 * path (the app's per-caller settings) and the background path (the connector the
 * scheduler builds outside any request) so the two never drift. A `secret` field
 * that won't decrypt is dropped rather than surfaced as ciphertext.
 */
export async function decryptPluginConfig(
  secret: string | undefined,
  configFields: { key: string; type: string }[],
  storedJson: string | null,
): Promise<Record<string, string>> {
  if (!storedJson) return {};
  let stored: Record<string, string>;
  try {
    stored = JSON.parse(storedJson) as Record<string, string>;
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const f of configFields) {
    const v = stored[f.key];
    if (v == null) continue;
    if (f.type === "secret") {
      const dec = secret ? await decryptString(secret, v) : null;
      if (dec != null) out[f.key] = dec;
    } else {
      out[f.key] = v;
    }
  }
  return out;
}
