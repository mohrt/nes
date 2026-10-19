import { deflateSync } from 'node:zlib';
import { PALETTE_RGB } from '../../src/ppu/palette';
import { FRAME_HEIGHT, FRAME_WIDTH } from '../../src/ppu/ppu';
import { crc32 } from '../../src/util/crc32';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes a PPU frame (9-bit colours) as an RGB PNG, each pixel drawn 2x2. */
export function framePng(pixels: Uint16Array): Uint8Array {
  const width = FRAME_WIDTH * 2;
  const height = FRAME_HEIGHT * 2;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const rgb = PALETTE_RGB[pixels[(y >> 1) * FRAME_WIDTH + (x >> 1)]];
      raw.set([(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff], row + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
