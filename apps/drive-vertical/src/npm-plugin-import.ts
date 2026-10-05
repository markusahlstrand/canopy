import { resolvePlugin } from '@canopy/plugin-sources';

/** Resolve an npm package to a pinned version and a bounded bundled entry for Studio review. */
export async function importNpmPlugin(ref: { name: string; version?: string }, fetchEntry: typeof fetch) {
  const resolved = await resolvePlugin({ type: 'npm', ...ref }, { fetch: fetchEntry });
  if (!('code' in resolved.entry) || !resolved.integrity) throw new Error('npm plugin has no verified JavaScript entry.');
  const source = resolved.entry.code;
  return { manifest: resolved.manifest, source, provenance: {
    kind: 'npm' as const,
    ref: `${ref.name}@${ref.version || 'latest'}`,
    resolved: `${resolved.version} ${resolved.integrity}`,
  } };
}
