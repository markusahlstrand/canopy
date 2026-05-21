// Canopy viewer plugin — runs inside a sandboxed, opaque-origin iframe.
//
// The host hands us ONLY the previewed file (name, MIME, bytes). We have no
// access to the host page, its cookies, storage, or network origin — this code
// is untrusted by design. We render the image from the bytes we were given.
//
// Contract: export a default `render(ctx)` where
//   ctx.container  HTMLElement to render into
//   ctx.file       { name: string, mime: string, bytes: ArrayBuffer }
//   ctx.emit       (action: string, data?: unknown) => void  — message the host

export default function render(ctx) {
  const { container, file } = ctx;
  const blob = new Blob([file.bytes], { type: file.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);

  const img = document.createElement("img");
  img.alt = file.name;
  img.src = url;
  img.style.maxWidth = "100%";
  img.style.maxHeight = "78vh";
  img.style.objectFit = "contain";
  img.style.display = "block";
  img.style.margin = "0 auto";
  img.style.borderRadius = "10px";

  img.addEventListener("load", () => {
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
