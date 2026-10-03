import { Inflate, strFromU8 } from 'fflate';

interface Entry { name: string; size: number; originalSize: number; method: number; crc: number; local: number; start: number; end: number; }
const invalid = () => new Error('invalid or unsupported ZIP structure');
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

/** Classic single-disk ZIP only. Validate every record before allocating any output. */
export function unpackZip(bytes: Uint8Array, admit: (entry: Pick<Entry, 'name' | 'size' | 'originalSize'>) => void): Record<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = (offset: number, length: number, end = bytes.length) => {
    if (offset < 0 || length < 0 || offset + length > end) throw invalid();
  };
  const u16 = (offset: number) => { range(offset, 2); return view.getUint16(offset, true); };
  const u32 = (offset: number) => { range(offset, 4); return view.getUint32(offset, true); };
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { eocd = offset; break; }
  }
  if (eocd < 0 || u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== u16(eocd + 10)) throw invalid();
  const count = u16(eocd + 10), centralSize = u32(eocd + 12), centralStart = u32(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff || centralStart + centralSize !== eocd) throw invalid();
  const entries: Entry[] = [];
  let cursor = centralStart;
  for (let index = 0; index < count; index++) {
    range(cursor, 46, eocd);
    if (u32(cursor) !== 0x02014b50 || u16(cursor + 34)) throw invalid();
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
    const size = u32(cursor + 20), originalSize = u32(cursor + 24);
    const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32);
    const local = u32(cursor + 42);
    if ((flags & ~0x080e) || (method !== 0 && method !== 8) || size === 0xffffffff || originalSize === 0xffffffff || local === 0xffffffff) throw invalid();
    range(cursor + 46, nameLength + extraLength + commentLength, eocd);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = strFromU8(nameBytes, !(flags & 0x0800));
    admit({ name, size, originalSize });
    range(local, 30, centralStart);
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength) throw invalid();
    const start = local + 30 + nameLength + u16(local + 28);
    range(local + 30, nameLength + u16(local + 28), centralStart);
    if (!nameBytes.every((byte, i) => byte === bytes[local + 30 + i])) throw invalid();
    range(start, size, centralStart);
    let end = start + size;
    if (flags & 8) {
      // Streaming ZIP writers put authoritative sizes in the trailing descriptor.
      const descriptor = u32(end) === 0x08074b50 ? end + 4 : end;
      range(descriptor, 12, centralStart);
      if (u32(descriptor) !== crc || u32(descriptor + 4) !== size || u32(descriptor + 8) !== originalSize) throw invalid();
      end = descriptor + 12;
    } else if (u32(local + 14) !== crc || u32(local + 18) !== size || u32(local + 22) !== originalSize) throw invalid();
    entries.push({ name, size, originalSize, method, crc, local, start, end });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== eocd) throw invalid();
  // Include local headers and descriptors, not just compressed payloads.
  const localOffsets = entries.map(entry => ({ start: entry.local, end: entry.end }));
  localOffsets.sort((a, b) => a.start - b.start);
  for (let index = 1; index < localOffsets.length; index++) {
    if (localOffsets[index]!.start < localOffsets[index - 1]!.end) throw new Error('zip has overlapping local entries');
  }
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const entry of entries) {
    const output = new Uint8Array(entry.originalSize);
    let produced = 0, checksum = 0xffffffff;
    const collect = (chunk: Uint8Array) => {
      if (produced + chunk.length > entry.originalSize) throw new Error(`zip entry size mismatch: ${entry.name}`);
      output.set(chunk, produced); produced += chunk.length;
      for (const byte of chunk) checksum = (checksum >>> 8) ^ crcTable[(checksum ^ byte) & 255]!;
    };
    if (entry.method === 0) collect(bytes.subarray(entry.start, entry.start + entry.size));
    else {
      const inflate = new Inflate(collect);
      // Small compressed chunks bound work/allocation between actual-output checks.
      // A lying size cannot make one push decode an entire multi-megabyte stream.
      const chunkBytes = 64;
      if (!entry.size) inflate.push(new Uint8Array(), true);
      for (let offset = 0; offset < entry.size; offset += chunkBytes) {
        inflate.push(bytes.subarray(entry.start + offset, entry.start + Math.min(entry.size, offset + chunkBytes)), offset + chunkBytes >= entry.size);
      }
    }
    if (produced !== entry.originalSize || ((checksum ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error(`zip entry size or checksum mismatch: ${entry.name}`);
    files[entry.name] = output;
  }
  return files;
}
