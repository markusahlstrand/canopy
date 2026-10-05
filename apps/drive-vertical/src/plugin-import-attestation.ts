import { installedPluginManifest } from '@canopy/scope-drive/spec/model';

export interface ImportClaim {
  principal: string;
  scope: string;
  kind: 'github' | 'npm';
  ref: string;
  resolved: string;
  manifestHash: string;
  sourceHash: string;
  expiresAt: number;
}

const encoder = new TextEncoder();
const bytesToBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const base64ToBytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));

async function sha256(value: string): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Bind a reviewed import to one principal, space, manifest and exact source for 15 minutes. */
export async function signPluginImport(secret: string, claim: Omit<ImportClaim, 'manifestHash' | 'sourceHash' | 'expiresAt'> & {manifest: unknown; source: string}): Promise<string> {
  const data: ImportClaim = {
    principal: claim.principal, scope: claim.scope, kind: claim.kind, ref: claim.ref, resolved: claim.resolved,
    manifestHash: await sha256(JSON.stringify(installedPluginManifest.parse(claim.manifest))),
    sourceHash: await sha256(claim.source), expiresAt: Date.now() + 15 * 60_000,
  };
  const payload = bytesToBase64(encoder.encode(JSON.stringify(data)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(`canopy-plugin-import-v1\0${payload}`));
  return `${payload}.${bytesToBase64(new Uint8Array(signature))}`;
}

/** Invalid or edited claims return null; the save path stores them as inline source. */
export async function verifyPluginImport(secret: string | undefined, token: unknown, principal: string, scope: string, manifest: unknown, source: unknown): Promise<Pick<ImportClaim, 'kind' | 'ref' | 'resolved'> | null> {
  if (!secret || typeof token !== 'string' || token.length > 3000 || typeof source !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  try {
    const valid = await crypto.subtle.verify('HMAC', await key(secret), base64ToBytes(signature).slice().buffer, encoder.encode(`canopy-plugin-import-v1\0${payload}`));
    if (!valid) return null;
    const claim = JSON.parse(new TextDecoder().decode(base64ToBytes(payload))) as ImportClaim;
    if (claim.principal !== principal || claim.scope !== scope || claim.expiresAt < Date.now() ||
        !['github', 'npm'].includes(claim.kind) || typeof claim.ref !== 'string' || typeof claim.resolved !== 'string') return null;
    if (claim.sourceHash !== await sha256(source) || claim.manifestHash !== await sha256(JSON.stringify(installedPluginManifest.parse(manifest)))) return null;
    return {kind: claim.kind, ref: claim.ref, resolved: claim.resolved};
  } catch { return null; }
}
