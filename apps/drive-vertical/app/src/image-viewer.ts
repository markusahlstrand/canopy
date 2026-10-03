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
  #viewport: HTMLDivElement;
  #status: HTMLSpanElement;
  #hint: HTMLSpanElement;
  #buttons: HTMLButtonElement[] = [];
  #zoom: number | null = null; // null fits the available box without upscaling.
  #loaded = false;
  #fitted = 1;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
      .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 4px 0 8px; font: 12px system-ui; }
      button { color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 4px; padding: 4px 8px; }
      button:disabled { opacity: .4; }
      .viewport { display: flex; flex: 1; min-height: 0; overflow: auto; width: 100%; }
      .viewport:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
      img { display: block; flex: none; border-radius: 10px; }
    `;
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Image zoom');
    const button = (label: string, action: () => void) => {
      const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
      node.addEventListener('click', action); this.#buttons.push(node); toolbar.append(node); return node;
    };
    button('Zoom out', () => this.#changeZoom(1 / 1.25));
    button('Zoom in', () => this.#changeZoom(1.25));
    button('Actual size', () => this.#setZoom(1));
    button('Fit image', () => { this.#zoom = null; this.#apply(); this.#resetScroll(); });
    this.#status = document.createElement('span'); this.#status.setAttribute('role', 'status'); toolbar.append(this.#status);
    this.#viewport = document.createElement('div'); this.#viewport.className = 'viewport';
    this.#viewport.tabIndex = 0;
    this.#viewport.setAttribute('role', 'region');
    this.#viewport.setAttribute('aria-label', 'Image viewport');
    this.#viewport.setAttribute('aria-keyshortcuts', 'Plus = - 0 F');
    this.#viewport.setAttribute('aria-describedby', 'zoom-shortcuts');
    const hint = this.#hint = document.createElement('span'); hint.id = 'zoom-shortcuts';
    hint.textContent = 'Focus the image: +/− zoom, 0 actual size, F fit. Arrow keys scroll.';
    hint.style.font = '12px system-ui';
    this.#viewport.addEventListener('pointerdown', () => this.#viewport.focus({ preventScroll: true }));
    this.#viewport.addEventListener('keydown', event => {
      if (event.target !== this.#viewport || !this.#loaded || !this.#file || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.key === '+' || event.key === '=') this.#changeZoom(1.25);
      else if (event.key === '-') this.#changeZoom(1 / 1.25);
      else if (event.key === '0') this.#setZoom(1);
      else if (event.key.toLowerCase() === 'f') { this.#zoom = null; this.#apply(); this.#resetScroll(); }
      else return;
      event.preventDefault(); event.stopPropagation();
    });
    this.#image = document.createElement('img');
    this.#image.addEventListener('load', () => {
      this.#loaded = true; this.#apply();
      this.dispatchEvent(new CustomEvent('viewer-loaded', { detail: { width: this.#image.naturalWidth, height: this.#image.naturalHeight } }));
    });
    this.#image.addEventListener('error', () => { this.#loaded = false; this.#apply(); this.dispatchEvent(new CustomEvent('viewer-error')); });
    this.#viewport.append(this.#image); shadow.append(style, toolbar, hint, this.#viewport); this.#apply();
  }
  #minimumZoom() {
    const width = this.#viewport.clientWidth / this.#image.naturalWidth;
    const height = this.#viewport.clientHeight / this.#image.naturalHeight;
    const fitted = width > 0 && height > 0 ? Math.min(1, width, height) : this.#fitted;
    return Math.min(.25, fitted);
  }
  #changeZoom(factor: number) {
    if (!this.#loaded) return;
    if (this.#zoom === null) this.#fitted = this.#image.clientWidth / this.#image.naturalWidth || 1;
    const previous = this.#zoom ?? this.#fitted;
    const minimum = this.#minimumZoom();
    const candidate = previous * factor;
    const next = candidate <= minimum * (1 + 1e-10) ? minimum : Math.min(4, candidate);
    if (next !== previous) this.#setZoom(next);
  }
  #setZoom(zoom: number) {
    if (!this.#loaded) return;
    if (this.#zoom === null) this.#fitted = this.#image.clientWidth / this.#image.naturalWidth || 1;
    const previous = this.#zoom ?? this.#fitted;
    const halfWidth = this.#viewport.clientWidth / 2, halfHeight = this.#viewport.clientHeight / 2;
    const left = this.#zoom === null ? Math.max(0, halfWidth - this.#image.naturalWidth * previous / 2) : 0;
    const top = this.#zoom === null ? Math.max(0, halfHeight - this.#image.naturalHeight * previous / 2) : 0;
    const centerX = (this.#viewport.scrollLeft + halfWidth - left) / previous;
    const centerY = (this.#viewport.scrollTop + halfHeight - top) / previous;
    this.#zoom = zoom; this.#apply();
    this.#viewport.scrollLeft = Math.max(0, centerX * zoom - halfWidth);
    this.#viewport.scrollTop = Math.max(0, centerY * zoom - halfHeight);
  }
  #resetScroll() { this.#viewport.scrollLeft = 0; this.#viewport.scrollTop = 0; }
  #apply() {
    this.#hint.hidden = !this.#loaded;
    const fit = this.#zoom === null;
    this.#image.style.width = fit ? 'auto' : `${this.#image.naturalWidth * this.#zoom!}px`;
    this.#image.style.height = fit ? 'auto' : `${this.#image.naturalHeight * this.#zoom!}px`;
    this.#image.style.maxWidth = fit ? `min(100%, ${this.#image.naturalWidth}px)` : 'none';
    this.#image.style.maxHeight = fit ? `min(100%, ${this.#image.naturalHeight}px)` : 'none';
    this.#viewport.style.alignItems = fit ? 'center' : 'flex-start';
    this.#viewport.style.justifyContent = fit ? 'center' : 'flex-start';
    if (fit && this.#loaded) this.#fitted = this.#image.clientWidth / this.#image.naturalWidth || 1;
    this.#status.textContent = fit ? 'Fit' : `${Math.round(this.#zoom! * 100)}%`;
    this.#buttons.forEach((node, index) => {
      node.disabled = !this.#file || !this.#loaded || (index === 0 && (this.#zoom ?? this.#fitted) <= this.#minimumZoom()) || (index === 1 && this.#zoom === 4);
    });
  }
  get file(): ViewerFile | null { return this.#file; }
  set file(file: ViewerFile | null) {
    this.#file = file; this.#zoom = null; this.#loaded = false; this.#fitted = 1;
    this.#image.alt = file?.name ?? '';
    if (file) this.#image.src = file.contentUrl;
    else this.#image.removeAttribute('src');
    this.#apply(); this.#resetScroll();
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
