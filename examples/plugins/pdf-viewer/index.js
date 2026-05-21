// Canopy viewer plugin — runs inside a sandboxed, opaque-origin iframe.
//
// We render the PDF the host handed us using the browser's native PDF engine.
// The bytes become a blob URL that is same-origin to *this* opaque iframe only,
// so nothing leaves the sandbox. No external libraries, no network.
//
// Contract: export a default `render(ctx)` (see image-viewer for the shape).

export default function render(ctx) {
  const { container, file } = ctx;
  const blob = new Blob([file.bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  const frame = document.createElement("iframe");
  frame.src = url;
  frame.title = file.name;
  frame.style.width = "100%";
  frame.style.height = "78vh";
  frame.style.border = "0";
  frame.style.borderRadius = "10px";
  frame.style.background = "#fff";

  // Fallback: if the native engine can't render inline, offer a download.
  const fallback = document.createElement("div");
  fallback.style.cssText = "text-align:center;padding:32px;color:#6b7280;font:14px system-ui,sans-serif";
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.textContent = `Download ${file.name}`;
  link.style.color = "#3F7A55";
  fallback.append(`Inline preview unavailable. `, link);

  container.appendChild(frame);
  container.appendChild(fallback);
  ctx.emit("loaded", { name: file.name });
}
