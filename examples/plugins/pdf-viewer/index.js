// Canopy viewer plugin — runs inside a sandboxed, opaque-origin iframe.
//
// The browser's *native* PDF viewer is blocked inside a sandboxed frame, so we
// render with pdf.js to a <canvas> instead — pure JS, no plugin needed. pdf.js
// is loaded from a CDN (this viewer needs network); if that fails we fall back
// to a download link. The host hands us only this file's bytes.
//
// Contract: export default `render(ctx)` with ctx.{container, file, emit}.

const CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4";

export default async function render(ctx) {
  const { container, file } = ctx;
  try {
    const pdfjs = await import(`${CDN}/build/pdf.min.mjs`);
    // Module workers can't be created from a cross-origin URL, so fetch the
    // worker and run it from a blob (same opaque origin as this frame).
    const workerBlob = await fetch(`${CDN}/build/pdf.worker.min.mjs`).then((r) => r.blob());
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);

    const pdf = await pdfjs.getDocument({
      data: file.bytes.slice(0), // copy: pdf.js detaches the buffer it's given
      cMapUrl: `${CDN}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${CDN}/standard_fonts/`,
    }).promise;

    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.cssText =
        "display:block;margin:0 auto 12px;max-width:100%;height:auto;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.18)";
      container.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    }
    ctx.emit("loaded", { name: file.name, pages: pdf.numPages });
  } catch (err) {
    const url = URL.createObjectURL(new Blob([file.bytes], { type: "application/pdf" }));
    const wrap = document.createElement("div");
    wrap.style.cssText = "text-align:center;padding:32px;color:#6b7280;font:14px system-ui,sans-serif";
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.textContent = `Download ${file.name}`;
    link.style.color = "#3F7A55";
    wrap.append("Couldn't render this PDF inline. ", link);
    container.appendChild(wrap);
    ctx.emit("error", { name: file.name, message: String((err && err.message) || err) });
  }
}
