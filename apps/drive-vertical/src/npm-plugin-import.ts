import { resolvePlugin } from '@canopy/plugin-sources';
import { fetchPluginSource } from './plugin-import-source';

/** Resolve an npm package to a pinned version and a bounded bundled entry for Studio review. */
export async function importNpmPlugin(ref: { name: string; version?: string }, fetchEntry: typeof fetch) {
  const resolved = await resolvePlugin({ type: 'npm', ...ref });
  if (!('url' in resolved.entry)) throw new Error('npm plugin has no JavaScript entry.');
  const source = await fetchPluginSource(resolved.entry.url, fetchEntry);
  return { manifest: resolved.manifest, source, provenance: {
    kind: 'npm' as const,
    ref: `${ref.name}@${ref.version || 'latest'}`,
    resolved: resolved.version,
  } };
}
