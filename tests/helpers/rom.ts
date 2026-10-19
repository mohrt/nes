import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCartridge } from '../../src/cart/create';
import { parseInes } from '../../src/cart/ines';
import { Nes } from '../../src/nes';

export const testRomsDir = join(import.meta.dirname, '..', 'fixtures', 'test-roms');

export function testRomPath(file: string): string {
  return join(testRomsDir, file);
}

export const hasTestRom = (file: string) => existsSync(testRomPath(file));

/** An iNES image: 16-byte header, then PRG and CHR. */
export function inesImage(options: {
  prg: Uint8Array;
  chr?: Uint8Array;
  mapper?: number;
  vertical?: boolean;
  battery?: boolean;
}): Uint8Array {
  const chr = options.chr ?? new Uint8Array(0);
  const mapper = options.mapper ?? 0;
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, options.prg.length / 0x4000, chr.length / 0x2000]);
  header[6] = ((mapper & 0x0f) << 4) | (options.vertical ? 1 : 0) | (options.battery ? 2 : 0);
  header[7] = mapper & 0xf0;
  const image = new Uint8Array(16 + options.prg.length + chr.length);
  image.set(header);
  image.set(options.prg, 16);
  image.set(chr, 16 + options.prg.length);
  return image;
}

/** A console with the given cartridge image in, switched on. */
export function nesWith(image: Uint8Array): Nes {
  const nes = new Nes();
  nes.insertCartridge(createCartridge(parseInes(image)));
  return nes;
}

export function nesWithTestRom(file: string): Nes {
  return nesWith(new Uint8Array(readFileSync(testRomPath(file))));
}
