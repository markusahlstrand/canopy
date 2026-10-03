import { viewerMatches, type PluginManifest } from '@canopy/core';
import { defineFileViewer } from './web-component';

export interface ViewerDefinition { tagName: string; constructor: CustomElementConstructor }
export interface RegisteredViewer { pluginId: string; id: string; tagName: string; match: readonly string[] }

/** Only constructors reviewed and bundled with the app may reach install(); never downloaded code.
 * Trusted web components only. This registry is not a sandbox or an arbitrary-code installer. */
export class FileViewerRegistry {
  #plugins = new Map<string, RegisteredViewer[]>();
  #listeners = new Set<() => void>();
  #revision = 0;
  has = (pluginId: string): boolean => this.#plugins.has(pluginId);
  /** A snapshot of installed contributions; callers cannot mutate selection rules. */
  list = (): RegisteredViewer[] => [...this.#plugins.values()].flat().map(viewer => ({ ...viewer, match: [...viewer.match] }));
  snapshot = (): number => this.#revision;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  #changed() { this.#revision++; for (const listener of this.#listeners) listener(); }

  /** A reviewed loader supplies the constructors; the manifest supplies selection rules. */
  install(manifest: Pick<PluginManifest, 'id' | 'contributes'>, definitions: Record<string, ViewerDefinition>): () => void {
    if (this.#plugins.has(manifest.id)) throw new Error(`viewer plugin already installed: ${manifest.id}`);
    const ids = new Set<string>();
    const tags = new Map<string, CustomElementConstructor>();
    const constructors = new Map<CustomElementConstructor, string>();
    const viewers = (manifest.contributes?.viewers ?? []).map(viewer => {
      const definition = definitions[viewer.id];
      if (ids.has(viewer.id) || !definition || !viewer.match.length) throw new Error(`invalid viewer: ${viewer.id}`);
      ids.add(viewer.id);
      if (!definition.tagName.includes('-')) throw new Error('viewer tag must be a custom element name');
      const tagConstructor = tags.get(definition.tagName);
      const constructorTag = constructors.get(definition.constructor);
      if ((tagConstructor && tagConstructor !== definition.constructor) || (constructorTag && constructorTag !== definition.tagName)) {
        throw new Error(`viewer definition collision: ${viewer.id}`);
      }
      tags.set(definition.tagName, definition.constructor);
      constructors.set(definition.constructor, definition.tagName);
      const existing = customElements.get(definition.tagName);
      if (existing && existing !== definition.constructor) throw new Error(`viewer tag collision: ${definition.tagName}`);
      return { pluginId: manifest.id, id: viewer.id, tagName: definition.tagName, match: [...viewer.match] };
    });
    // Validate the entire batch before publishing it to preview subscribers.
    for (const viewer of viewers) { const definition = definitions[viewer.id]!; defineFileViewer(definition.tagName, definition.constructor); }
    this.#plugins.set(manifest.id, viewers);
    this.#changed();
    return () => {
      if (this.#plugins.get(manifest.id) !== viewers) return;
      this.#plugins.delete(manifest.id);
      this.#changed();
    };
  }

  /** Specific matches win; equal matches keep installation order. MIME parameters are ignored. */
  resolve(file: { mime: string; name: string }): RegisteredViewer | null {
    const mime = file.mime.split(';')[0]!.trim().toLowerCase();
    const ext = file.name.includes('.') ? file.name.split('.').at(-1) : undefined;
    let winner: RegisteredViewer | null = null;
    let best = 0;
    for (const viewers of this.#plugins.values()) for (const viewer of viewers) {
      const score = Math.max(0, ...viewer.match.map(pattern => {
        const rule = pattern.trim().toLowerCase();
        if (!rule || !viewerMatches([rule], { mime, ext })) return 0;
        if (rule === mime) return 3;
        if (rule.endsWith('/*')) return 2;
        if (!rule.includes('/')) return 1;
        return 0;
      }));
      if (score > best) { winner = viewer; best = score; }
    }
    return winner;
  }
}
