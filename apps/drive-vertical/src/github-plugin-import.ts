import { resolvePlugin } from '@canopy/plugin-sources';
import { fetchPluginSource } from './plugin-import-source';

/** Resolve a public GitHub plugin to a pinned commit and a bounded, single entry file. */
export async function importGithubPlugin(ref: { repo: string; ref?: string; path?: string }, fetchEntry: typeof fetch, githubToken?: string) {
  const resolved = await resolvePlugin({ type: 'github', ...ref }, { githubToken });
  if (!('url' in resolved.entry)) throw new Error('GitHub plugin has no JavaScript entry.');
  const source = await fetchPluginSource(resolved.entry.url, fetchEntry);
  return { manifest: resolved.manifest, source, provenance: {
    kind: 'github' as const,
    ref: `${ref.repo}${ref.path ? `/${ref.path}` : ''}@${ref.ref || 'main'}`,
    resolved: resolved.version,
  } };
}
