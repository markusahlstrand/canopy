import type { DriveFile, FileVersion } from './api';

function Timestamp({ value }: { value: string | null | undefined }) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? <time dateTime={date.toISOString()}>{date.toLocaleString()}</time> : <>Unknown</>;
}

/** Uses the same permission-checked snapshot as the preview, without another read. */
export function FileMetadata({ file, version, size, canWrite }: {
  file: DriveFile; version: FileVersion | null; size: string; canWrite: boolean;
}) {
  const entries = [
    ['Name', file.name],
    ['Type', version?.mime || 'No current version'],
    ['Size', version ? size : 'Unknown'],
    ['Created', <Timestamp value={file.created_at} />],
    ['Last modified', <Timestamp value={file.updated_at} />],
    ['Current version saved', version ? <Timestamp value={version.created_at} /> : 'No current version'],
    ['Your access', canWrite ? 'Can edit' : 'Read only'],
  ] as const;
  return <section aria-label="File information" className="mb-5 space-y-2">
    <h3 className="text-sm font-medium">File information</h3>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {entries.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-words whitespace-pre-wrap">{value}</dd></div>)}
    </dl>
  </section>;
}
