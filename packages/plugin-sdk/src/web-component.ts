/**
 * Build-time file viewers for a hosted vertical. A viewer is bundled with the app and
 * runs in its origin. Only trusted, reviewed code belongs here: a custom element is
 * not an iframe sandbox, even when its public input is deliberately small.
 */
export interface ViewerFile {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  /** A same-origin, permission-checked URL for the current version's bytes. */
  readonly contentUrl: string;
}

/** The single host-to-viewer property. Setting null retires the previous file. */
export interface FileViewerElement extends HTMLElement {
  file: ViewerFile | null;
}

/**
 * Register a first-party viewer once, even when its module is imported by more than
 * one preview surface. Runtime installation is intentionally outside this contract.
 */
export function defineFileViewer(
  tagName: string,
  constructor: CustomElementConstructor,
): void {
  if (!tagName.includes('-')) throw new Error('a custom element name must contain a hyphen');
  const registered = customElements.get(tagName);
  if (registered && registered !== constructor) {
    throw new Error(`a different viewer is already registered as ${tagName}`);
  }
  if (!registered) customElements.define(tagName, constructor);
}
