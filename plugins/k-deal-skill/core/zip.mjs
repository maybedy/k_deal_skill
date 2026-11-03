/** Minimal ZIP reader (stored and deflate entries) for OpenDART downloads. No ZIP64, no encryption. */
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

export function isZip(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

/** Returns [{ name, data }] for every file entry, or only the entries whose name passes want(name).
 * Throws on a malformed archive. */
export function readZip(buffer, want = () => true) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const flags = buffer.readUInt16LE(offset + 8);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/') || !want(name)) continue;
    if (size > MAX_ENTRY_BYTES) throw new Error('zip: entry too large');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: bad local header');
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const body = buffer.subarray(start, start + compressed);
    let data;
    if (method === 0) data = body;
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES });
    else throw new Error(`zip: unsupported method ${method}`);
    entries.push({ name, data });
  }
  return entries;
}
