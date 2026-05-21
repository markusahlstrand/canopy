import type { UserProfile } from "./oidc";

/**
 * Stateless session: the whole session lives in an AES-GCM encrypted cookie,
 * so there's no server-side store to lose on restart and it ports to Workers.
 * Trade-off: no server-side revocation — rely on short access-token expiry +
 * refresh, and logout clears the cookie.
 */
export interface SessionData {
  user: UserProfile;
  accessToken: string;
  refreshToken?: string;
  /** Access-token expiry (ms epoch); triggers a refresh in /me. */
  expiresAt: number;
}

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

export async function seal(secret: string, data: SessionData): Promise<string> {
  const key = await keyFromSecret(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(data))),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64urlEncode(out);
}

export async function unseal(secret: string, token: string): Promise<SessionData | null> {
  try {
    const raw = b64urlDecode(token);
    const iv = raw.slice(0, 12);
    const ct = raw.slice(12);
    const key = await keyFromSecret(secret);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(decoder.decode(pt)) as SessionData;
  } catch {
    return null;
  }
}
