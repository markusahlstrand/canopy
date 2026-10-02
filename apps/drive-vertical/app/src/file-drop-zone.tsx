import { useEffect, useRef, useState, type ReactNode } from 'react';

/** External file drops upload to the displayed folder; internal drags remain moves. */
export function FileDropZone({ disabled, destination, onFiles, onError, children }: {
  disabled: boolean; destination: string; onFiles: (files: File[]) => void;
  onError: (message: string) => void; children: ReactNode;
}) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const external = (transfer: DataTransfer) => Array.from(transfer.types ?? []).includes('Files')
    && !Array.from(transfer.types ?? []).includes('application/x-canopy-file');
  useEffect(() => { depth.current = 0; setOver(false); }, [disabled, destination]);
  return <div aria-label="File upload area" className="relative min-w-0 flex-1"
    onDragEnter={event => {
      if (!external(event.dataTransfer)) return;
      event.preventDefault();
      depth.current++;
      if (!disabled) setOver(true);
    }}
    onDragOver={event => {
      if (!external(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    }}
    onDragLeave={event => {
      if (!external(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    }}
    onDrop={event => {
      if (!external(event.dataTransfer)) return;
      event.preventDefault();
      depth.current = 0; setOver(false);
      if (disabled) return;
      if (Array.from(event.dataTransfer.items ?? []).some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
        onError('Folder uploads are not supported. Choose individual files instead.');
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (files.length) onFiles(files);
    }}>
    {children}
    {over && !disabled ? <div role="status" className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-lg border-2 border-dashed border-primary bg-background/90 p-4 text-center">
      Drop files into {destination}
    </div> : null}
  </div>;
}
