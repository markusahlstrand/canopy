/** SHA-256 of the bytes, lowercase hex. Uses Web Crypto (Workers + Node 22). */
export async function sha256hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Cast at the Web Crypto boundary: TS's Uint8Array<ArrayBufferLike> generic
  // isn't assignable to BufferSource, but the value is a valid one at runtime.
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
