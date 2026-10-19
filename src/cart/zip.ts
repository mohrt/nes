const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** The end record is 22 bytes plus a comment of up to 64K. */
const MAX_END_SEARCH = 22 + 0xffff;

export interface ZipEntry {
  name: string;
  size: number;
  read(): Promise<Uint8Array>;
}

export function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && new DataView(data.buffer, data.byteOffset).getUint32(0, true) === LOCAL_HEADER;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Lists the files in a .zip archive (stored or deflated entries; no ZIP64 or encryption). */
export function readZip(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - MAX_END_SEARCH); i--) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('That .zip file looks damaged (no central directory).');

  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_HEADER) throw new Error('That .zip file looks damaged.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(data.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // a folder
    entries.push({
      name,
      size,
      read: async () => {
        if (flags & 0x01) throw new Error(`${name} in the zip is encrypted.`);
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = data.subarray(start, start + compressedSize);
        if (method === METHOD_STORED) return compressed.slice();
        if (method === METHOD_DEFLATE) return inflateRaw(compressed);
        throw new Error(`${name} in the zip uses an unsupported compression method.`);
      },
    });
  }
  return entries;
}

/** File types the emulator can use, in the order a zip's contents are preferred. */
const PREFERRED_EXTENSIONS = ['.nes', '.nesstate'];

/** The usable files in a zip, best first (cartridge images, then save states; then by name). */
export async function usableFilesInZip(data: Uint8Array): Promise<File[]> {
  const rank = (name: string) => PREFERRED_EXTENSIONS.findIndex((ext) => name.toLowerCase().endsWith(ext));
  const usable = readZip(data)
    .filter((entry) => rank(entry.name) >= 0 && !entry.name.split('/').pop()!.startsWith('.'))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return Promise.all(
    usable.map(async (entry) => new File([new Uint8Array(await entry.read())], entry.name.split('/').pop()!)),
  );
}
