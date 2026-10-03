import { FileViewerRegistry } from '@canopy/plugin-sdk/viewer-registry';
/**
 * The first-party image viewer from examples/plugins/image-viewer, now bundled into
 * the vertical as a web component. The hosted app supplies the current file's URL;
 * the scope's attachment route still checks the caller before returning bytes.
 */
import { type FileViewerElement, type ViewerFile } from '@canopy/plugin-sdk/web-component';

export const viewerRegistry = new FileViewerRegistry();

export const IMAGE_VIEWER_TAG = 'canopy-image-viewer';

export class ImageViewer extends HTMLElement implements FileViewerElement {
  #file: ViewerFile | null = null;
  #image: HTMLImageElement;

  /** Build the isolated rendering tree and relay the image's load state to the host. */
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center; }
      img { display: block; width: auto; height: auto; max-width: 100%; max-height: 100%; border-radius: 10px; }
    `;
    this.#image = document.createElement('img');
    this.#image.addEventListener('load', () => {
      // The old iframe viewer's DPI threshold was 1: a small image never grows
      // beyond its real pixels, while a large one still fits the available box.
      this.#image.style.maxWidth = `min(100%, ${this.#image.naturalWidth}px)`;
      this.#image.style.maxHeight = `min(100%, ${this.#image.naturalHeight}px)`;
      this.dispatchEvent(new CustomEvent('viewer-loaded', {
        detail: { width: this.#image.naturalWidth, height: this.#image.naturalHeight },
      }));
    });
    this.#image.addEventListener('error', () => {
      this.dispatchEvent(new CustomEvent('viewer-error'));
    });
    shadow.append(style, this.#image);
  }

  /** The file currently shown by this element, or null after preview cleanup. */
  get file(): ViewerFile | null { return this.#file; }

  /** Replace the image source and reset sizing inherited from the previous file. */
  set file(file: ViewerFile | null) {
    this.#file = file;
    this.#image.style.removeProperty('max-width');
    this.#image.style.removeProperty('max-height');
    this.#image.alt = file?.name ?? '';
    if (file) this.#image.src = file.contentUrl;
    else this.#image.removeAttribute('src');
  }
}

export const IMAGE_VIEWER_PREFERENCE = 'canopy.viewer.image';
let removeImageViewer: (() => void) | null = null;

function installImageViewer(): void {
  if (!viewerRegistry.has('image-viewer')) {
    removeImageViewer = viewerRegistry.install({ id: 'image-viewer', contributes: { viewers: [{ id: 'image', match: ['image/*'] }] } },
      { image: { tagName: IMAGE_VIEWER_TAG, constructor: ImageViewer } });
  }
}

function applyImageViewerEnabled(enabled: boolean): void {
  if (enabled) installImageViewer();
  else { removeImageViewer?.(); removeImageViewer = null; }
}

/** Register the reviewed built-in renderer using the browser's current preference. */
export function registerImageViewer(): void {
  try { applyImageViewerEnabled(localStorage.getItem(IMAGE_VIEWER_PREFERENCE) !== 'disabled'); }
  catch { installImageViewer(); }
}

/** Follow changes made by other same-origin tabs without writing storage back. */
export function watchImageViewerPreference(): () => void {
  const onStorage = (event: StorageEvent) => {
    try { if (event.storageArea !== localStorage) return; }
    catch { return; }
    if (event.key !== null && event.key !== IMAGE_VIEWER_PREFERENCE) return;
    // Events are queued: another tab (or this tab) may have written a newer value.
    registerImageViewer();
  };
  window.addEventListener('storage', onStorage);
  registerImageViewer();
  return () => window.removeEventListener('storage', onStorage);
}

/** A local preview preference, never a permission grant or downloaded-code install. */
export function setImageViewerEnabled(enabled: boolean): void {
  try { localStorage.setItem(IMAGE_VIEWER_PREFERENCE, enabled ? 'enabled' : 'disabled'); }
  catch { /* The current session can still toggle its bundled viewer. */ }
  applyImageViewerEnabled(enabled);
}
