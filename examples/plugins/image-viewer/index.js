// Canopy viewer plugin — runs inside a sandboxed, opaque-origin iframe.
//
// The host hands us ONLY the previewed file (name, MIME, bytes). We have no
// access to the host page, its cookies, storage, or network origin — this code
// is untrusted by design. We render the image from the bytes we were given.
//
// Contract: export a default `render(ctx)` where
//   ctx.container  HTMLElement to render into
//   ctx.file       { name: string, mime: string, bytes: ArrayBuffer }
//   ctx.fill       boolean — the host sized our frame to the available space; fit to it
//   ctx.emit       (action: string, data?: unknown) => void  — message the host

// Don't upscale a picture past its own pixels: blowing a small / low-resolution
// image up to fill a large panel just trades empty space for a blurry result.
// This is the "DPI threshold" — at 1 the image fills the available space until it
// hits 100% zoom, then stops and stays centered. Raise it to let small images
// grow further (accepting a lower effective resolution).
const MAX_UPSCALE = 1;

export default function render(ctx) {
  const { container, file, fill } = ctx;
  const blob = new Blob([file.bytes], { type: file.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);

  const img = document.createElement("img");
  img.alt = file.name;
  img.src = url;
  // `width/height: auto` + `max-*` lets the browser scale the image down to fit
  // while preserving its aspect ratio. When the host has given us a real box to
  // fill, `max-height: 100%` constrains us vertically too; otherwise the frame
  // grows to our height, so we only cap the width.
  img.style.width = "auto";
  img.style.height = "auto";
  img.style.maxWidth = "100%";
  if (fill) img.style.maxHeight = "100%";
  img.style.display = "block";
  img.style.borderRadius = "10px";

  img.addEventListener("load", () => {
    // Now that the real pixel size is known, cap the fit at it (the DPI threshold).
    const maxW = Math.round(img.naturalWidth * MAX_UPSCALE);
    const maxH = Math.round(img.naturalHeight * MAX_UPSCALE);
    img.style.maxWidth = `min(100%, ${maxW}px)`;
    img.style.maxHeight = fill ? `min(100%, ${maxH}px)` : `${maxH}px`;
    ctx.emit("loaded", { name: file.name, width: img.naturalWidth, height: img.naturalHeight });
  });
  img.addEventListener("error", () => {
    container.textContent = `Could not render ${file.name}`;
    container.style.color = "#9ca3af";
    container.style.textAlign = "center";
    container.style.padding = "40px";
    ctx.emit("error", { name: file.name });
  });

  container.appendChild(img);
}
