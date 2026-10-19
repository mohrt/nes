export type Mirroring = 'horizontal' | 'vertical' | 'four-screen';
export type Region = 'ntsc' | 'pal';

/** What an iNES or NES 2.0 header says about a cartridge, with the ROM split into PRG and CHR. */
export interface RomInfo {
  mapper: number;
  submapper: number;
  prg: Uint8Array;
  /** Empty when the board has CHR RAM instead. */
  chr: Uint8Array;
  chrRamSize: number;
  prgRamSize: number;
  /** Battery-backed PRG RAM: the game saves into it. */
  battery: boolean;
  mirroring: Mirroring;
  /** The TV system the header gives, or null if it doesn't say. */
  region: Region | null;
  nes2: boolean;
}

export const HEADER_SIZE = 16;
const TRAINER_SIZE = 512;
const PRG_UNIT = 0x4000;
const CHR_UNIT = 0x2000;
const DEFAULT_PRG_RAM = 0x2000;
const DEFAULT_CHR_RAM = 0x2000;

export function hasInesHeader(image: Uint8Array): boolean {
  return image.length >= HEADER_SIZE && image[0] === 0x4e && image[1] === 0x45 && image[2] === 0x53 && image[3] === 0x1a;
}

/** NES 2.0 sizes: a count of units, or (when the high nibble is $F) 2^E * (M*2+1) bytes. */
function nes2RomSize(lsb: number, msbNibble: number, unit: number): number {
  if (msbNibble === 0x0f) return 2 ** (lsb >> 2) * ((lsb & 3) * 2 + 1);
  return ((msbNibble << 8) | lsb) * unit;
}

/** NES 2.0 RAM sizes: 64 << shift bytes, or none. */
const nes2RamSize = (shift: number) => (shift === 0 ? 0 : 64 << shift);

export function parseInes(image: Uint8Array): RomInfo {
  if (!hasInesHeader(image)) throw new Error("That file isn't an NES cartridge image (it has no iNES header).");
  const flags6 = image[6];
  const flags7 = image[7];
  const nes2 = (flags7 & 0x0c) === 0x08;
  // Old dumping tools wrote text such as "DiskDude!" into bytes 7-15; then only the low mapper nibble is real.
  const dirtyTail = !nes2 && image.subarray(12, 16).some((byte) => byte !== 0);

  let mapper = (flags6 >> 4) | (dirtyTail ? 0 : flags7 & 0xf0);
  let submapper = 0;
  let prgSize = image[4] * PRG_UNIT;
  let chrSize = image[5] * CHR_UNIT;
  let prgRamSize = DEFAULT_PRG_RAM;
  let chrRamSize = chrSize === 0 ? DEFAULT_CHR_RAM : 0;
  let region: Region | null = null;

  if (nes2) {
    mapper |= (image[8] & 0x0f) << 8;
    submapper = image[8] >> 4;
    prgSize = nes2RomSize(image[4], image[9] & 0x0f, PRG_UNIT);
    chrSize = nes2RomSize(image[5], image[9] >> 4, CHR_UNIT);
    const ram = nes2RamSize(image[10] & 0x0f) + nes2RamSize(image[10] >> 4);
    if (ram > 0) prgRamSize = ram;
    const chrRam = nes2RamSize(image[11] & 0x0f) + nes2RamSize(image[11] >> 4);
    chrRamSize = chrSize === 0 ? chrRam || DEFAULT_CHR_RAM : chrRam;
    const timing = image[12] & 0x03;
    region = timing === 1 ? 'pal' : timing === 0 ? 'ntsc' : null;
  } else if (!dirtyTail && image[9] & 0x01) {
    region = 'pal';
  }

  const prgStart = HEADER_SIZE + (flags6 & 0x04 ? TRAINER_SIZE : 0);
  if (prgSize === 0) throw new Error('The cartridge header says it has no program ROM.');
  if (image.length < prgStart + prgSize) throw new Error('That cartridge image is shorter than its header says (a bad dump?).');
  const prg = image.slice(prgStart, prgStart + prgSize);
  // Some dumps are cut short in the CHR ROM; use what is there.
  const chr = image.slice(prgStart + prgSize, prgStart + prgSize + chrSize);

  return {
    mapper,
    submapper,
    prg,
    chr,
    chrRamSize,
    prgRamSize,
    battery: (flags6 & 0x02) !== 0,
    mirroring: flags6 & 0x08 ? 'four-screen' : flags6 & 0x01 ? 'vertical' : 'horizontal',
    region,
    nes2,
  };
}

/** Guesses the TV system from a file name such as "Game (Europe).nes" or "Game (E) [!].nes". */
export function regionFromFileName(name: string): Region | null {
  if (/\((?:[^)]*\b(?:USA|Japan|NTSC)\b[^)]*)\)|\((?:U|J|JU|UJ)\)/i.test(name)) return 'ntsc';
  if (/\((?:[^)]*\b(?:Europe|PAL|Australia|Germany|France|Spain|Italy|Sweden|Netherlands|UK)\b[^)]*)\)|\((?:E|A|G|F|S|I)\)/i.test(name)) {
    return 'pal';
  }
  return null;
}
