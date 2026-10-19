import { Cartridge } from './cartridge';
import type { RomInfo } from './ines';
import { AxRom, Bnrom, Camerica, CnRom, ColorDreams, GxRom, UxRom } from './mappers/discrete';
import { Mmc1 } from './mappers/mmc1';
import { Mmc2 } from './mappers/mmc2';
import { Mmc3, Namco108 } from './mappers/mmc3';

const MAPPERS: Record<number, { name: string; create: (info: RomInfo) => Cartridge }> = {
  0: { name: 'NROM', create: (info) => new Cartridge(info) },
  1: { name: 'MMC1', create: (info) => new Mmc1(info) },
  2: { name: 'UxROM', create: (info) => new UxRom(info) },
  3: { name: 'CNROM', create: (info) => new CnRom(info) },
  4: { name: 'MMC3', create: (info) => new Mmc3(info) },
  7: { name: 'AxROM', create: (info) => new AxRom(info) },
  9: { name: 'MMC2', create: (info) => new Mmc2(info, false) },
  10: { name: 'MMC4', create: (info) => new Mmc2(info, true) },
  11: { name: 'Color Dreams', create: (info) => new ColorDreams(info) },
  34: { name: 'BNROM / NINA-001', create: (info) => new Bnrom(info) },
  66: { name: 'GxROM', create: (info) => new GxRom(info) },
  71: { name: 'Camerica', create: (info) => new Camerica(info) },
  206: { name: 'Namco 108', create: (info) => new Namco108(info) },
};

/** Names of common mappers this emulator doesn't have yet, for a clearer message. */
const UNSUPPORTED: Record<number, string> = {
  5: 'MMC5',
  19: 'Namco 163',
  21: 'Konami VRC4',
  22: 'Konami VRC2',
  23: 'Konami VRC2/VRC4',
  24: 'Konami VRC6',
  25: 'Konami VRC4',
  26: 'Konami VRC6',
  69: 'Sunsoft FME-7',
  85: 'Konami VRC7',
};

export const SUPPORTED_MAPPERS = Object.keys(MAPPERS).map(Number);

export function mapperName(mapper: number): string {
  return MAPPERS[mapper]?.name ?? UNSUPPORTED[mapper] ?? `mapper ${mapper}`;
}

export function createCartridge(info: RomInfo): Cartridge {
  const mapper = MAPPERS[info.mapper];
  if (!mapper) {
    const name = UNSUPPORTED[info.mapper];
    throw new Error(`This game uses mapper ${info.mapper}${name ? ` (${name})` : ''}, which this emulator doesn't support yet.`);
  }
  const cartridge = mapper.create(info);
  cartridge.reset();
  return cartridge;
}
