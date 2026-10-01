/**
 * The first-party image viewer from examples/plugins/image-viewer, now bundled into
 * the vertical as a web component. The hosted app supplies the current file's URL;
 * the scope's attachment route still checks the caller before returning bytes.
 */
import { defineFileViewer, type FileViewerElement, type ViewerFile } from '@canopy/plugin-sdk/web-component';

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

/** Register the built-in image renderer once during the vertical's bundle startup. */
export function registerImageViewer(): void {
  defineFileViewer(IMAGE_VIEWER_TAG, ImageViewer);
}
