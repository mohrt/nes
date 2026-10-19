import { describe, expect, it } from 'vitest';
import type { Cartridge } from '../src/cart/cartridge';
import { createCartridge } from '../src/cart/create';
import { parseInes, regionFromFileName } from '../src/cart/ines';
import { inesImage } from './helpers/rom';

/** PRG where every byte holds its 8K bank number, CHR where every byte holds its 1K bank number. */
const prgBanks = (kb: number) => new Uint8Array(kb * 1024).map((_, i) => i >> 13);
const chrBanks = (kb: number) => new Uint8Array(kb * 1024).map((_, i) => i >> 10);

function cart(mapper: number, prgKb: number, chrKb = 0, options: { battery?: boolean; vertical?: boolean } = {}): Cartridge {
  const chr = chrKb ? chrBanks(chrKb) : undefined;
  return createCartridge(parseInes(inesImage({ prg: prgBanks(prgKb), chr, mapper, ...options })));
}

/** The 8K PRG bank in each CPU window $8000, $A000, $C000, $E000. */
const prgWindows = (c: Cartridge) => [0x8000, 0xa000, 0xc000, 0xe000].map((addr) => c.cpuRead(addr));
/** The 1K CHR bank in each PPU window. */
const chrWindows = (c: Cartridge) => Array.from({ length: 8 }, (_, i) => c.ppuRead(i * 0x400));

/** Writes a value to an MMC1 register the way games do: five writes, one bit each. */
function mmc1Write(c: Cartridge, addr: number, value: number): void {
  for (let bit = 0; bit < 5; bit++) {
    c.cpuCycle += 2;
    c.cpuWrite(addr, (value >> bit) & 1);
  }
}

describe('iNES headers', () => {
  it('reads the mapper, sizes, mirroring and battery', () => {
    const info = parseInes(inesImage({ prg: prgBanks(32), chr: chrBanks(8), mapper: 0x42, vertical: true, battery: true }));
    expect(info.mapper).toBe(0x42);
    expect(info.prg.length).toBe(0x8000);
    expect(info.chr.length).toBe(0x2000);
    expect(info.mirroring).toBe('vertical');
    expect(info.battery).toBe(true);
    expect(info.chrRamSize).toBe(0);
  });

  it('gives CHR RAM to cartridges without CHR ROM, and skips a trainer', () => {
    const image = inesImage({ prg: prgBanks(16) });
    const withTrainer = new Uint8Array(image.length + 512);
    withTrainer.set(image.subarray(0, 16));
    withTrainer[6] |= 0x04;
    withTrainer.set(image.subarray(16), 16 + 512);
    const info = parseInes(withTrainer);
    expect(info.chrRamSize).toBe(0x2000);
    expect(info.prg[0x2000]).toBe(1);
  });

  it('ignores the upper mapper nibble when old tools wrote text over the header', () => {
    const image = inesImage({ prg: prgBanks(16), mapper: 0x44 });
    image.set(new TextEncoder().encode('DiskDude!'), 7);
    expect(parseInes(image).mapper).toBe(4);
  });

  it('reads NES 2.0 mapper bits, RAM sizes and the TV system', () => {
    const image = inesImage({ prg: prgBanks(16), mapper: 4 });
    image[7] |= 0x08;
    image[8] = 0x21; // submapper 2, mapper bits 8-11 = 1
    image[10] = 0x07; // 64 << 7 = 8K of PRG RAM
    image[12] = 0x01; // PAL
    const info = parseInes(image);
    expect(info.nes2).toBe(true);
    expect(info.mapper).toBe(0x104);
    expect(info.submapper).toBe(2);
    expect(info.prgRamSize).toBe(0x2000);
    expect(info.region).toBe('pal');
  });

  it('rejects files that are not cartridges, or are cut short', () => {
    expect(() => parseInes(new Uint8Array(100))).toThrow(/iNES header/);
    expect(() => parseInes(inesImage({ prg: prgBanks(32) }).subarray(0, 0x4000))).toThrow(/shorter/);
  });

  it('guesses the TV system from the file name', () => {
    expect(regionFromFileName('Game (Europe).nes')).toBe('pal');
    expect(regionFromFileName('Game (E) [!].nes')).toBe('pal');
    expect(regionFromFileName('Game (USA, Europe).nes')).toBe('ntsc');
    expect(regionFromFileName('Game (U).nes')).toBe('ntsc');
    expect(regionFromFileName('game.nes')).toBe(null);
  });

  it('names unsupported mappers', () => {
    expect(() => cart(5, 128, 128)).toThrow(/mapper 5 \(MMC5\)/);
  });
});

describe('mappers', () => {
  it('NROM-128 mirrors its 16K at $C000', () => {
    expect(prgWindows(cart(0, 16, 8))).toEqual([0, 1, 0, 1]);
  });

  it('UxROM switches $8000 and fixes the last bank at $C000', () => {
    const c = cart(2, 128);
    expect(prgWindows(c)).toEqual([0, 1, 14, 15]);
    c.cpuWrite(0x8000, 3);
    expect(prgWindows(c)).toEqual([6, 7, 14, 15]);
  });

  it('CNROM switches 8K of CHR', () => {
    const c = cart(3, 32, 32);
    c.cpuWrite(0x8000, 2);
    expect(chrWindows(c)).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it('AxROM switches 32K and picks a one-screen nametable', () => {
    const c = cart(7, 128);
    c.cpuWrite(0x8000, 0x11);
    expect(prgWindows(c)).toEqual([4, 5, 6, 7]);
    expect([...c.nametables]).toEqual([0x400, 0x400, 0x400, 0x400]);
  });

  it('GxROM and Color Dreams switch PRG and CHR together', () => {
    const gx = cart(66, 128, 32);
    gx.cpuWrite(0x8000, 0x21);
    expect(prgWindows(gx)).toEqual([8, 9, 10, 11]);
    expect(chrWindows(gx)[0]).toBe(8);
    const cd = cart(11, 128, 128);
    cd.cpuWrite(0x8000, 0x32);
    expect(prgWindows(cd)).toEqual([8, 9, 10, 11]);
    expect(chrWindows(cd)[0]).toBe(24);
  });

  it('MMC1 loads registers a bit at a time and fixes the last bank in its power-on mode', () => {
    const c = cart(1, 256, 128);
    expect(prgWindows(c)).toEqual([0, 1, 30, 31]);
    mmc1Write(c, 0xe000, 5);
    expect(prgWindows(c)).toEqual([10, 11, 30, 31]);
    mmc1Write(c, 0x8000, 0x10 | 0x0c | 2); // 4K CHR, fix last, vertical
    mmc1Write(c, 0xa000, 3);
    mmc1Write(c, 0xc000, 7);
    expect(chrWindows(c)).toEqual([12, 13, 14, 15, 28, 29, 30, 31]);
    expect([...c.nametables]).toEqual([0, 0x400, 0, 0x400]);
  });

  it('MMC1 resets its shift register on bit 7 and ignores back-to-back writes', () => {
    const c = cart(1, 256);
    c.cpuWrite(0xe000, 1);
    c.cpuCycle += 1;
    c.cpuWrite(0xe000, 1); // the second write of a read-modify-write: ignored
    c.cpuCycle += 2;
    c.cpuWrite(0xe000, 0x80); // reset
    mmc1Write(c, 0xe000, 2);
    expect(prgWindows(c)[0]).toBe(4);
  });

  it('MMC3 maps its eight registers and swaps the PRG and CHR halves on request', () => {
    const c = cart(4, 256, 256);
    const select = (reg: number, value: number, modes = 0) => {
      c.cpuWrite(0x8000, modes | reg);
      c.cpuWrite(0x8001, value);
    };
    select(6, 3);
    select(7, 5);
    expect(prgWindows(c)).toEqual([3, 5, 30, 31]);
    c.cpuWrite(0x8000, 0x40);
    expect(prgWindows(c)).toEqual([30, 5, 3, 31]);
    select(0, 8);
    select(2, 20);
    expect(chrWindows(c).slice(0, 5)).toEqual([8, 9, 2, 3, 20]);
    c.cpuWrite(0x8000, 0x80);
    expect(chrWindows(c).slice(0, 5)).toEqual([20, 5, 6, 7, 8]);
  });

  it('MMC3 counts rises of PPU A12, filtering out short dips, and raises its IRQ at zero', () => {
    const c = cart(4, 128, 128);
    c.cpuWrite(0xc000, 2); // latch
    c.cpuWrite(0xc001, 0); // reload
    c.cpuWrite(0xe001, 0); // enable
    let dots = 0;
    const scanline = () => {
      dots += 341;
      c.ppuAddress(0x0000, dots); // background fetches (A12 low)
      c.ppuAddress(0x1000, dots + 260); // sprite fetches (A12 high): a rise
      c.ppuAddress(0x2000, dots + 262); // a short dip between sprite fetches
      c.ppuAddress(0x1000, dots + 264); // ...is not counted
    };
    scanline(); // reload to 2
    scanline(); // 1
    expect(c.irq).toBe(false);
    scanline(); // 0: IRQ
    expect(c.irq).toBe(true);
    c.cpuWrite(0xe000, 0);
    expect(c.irq).toBe(false);
  });

  it('MMC2 switches CHR when the PPU fetches tile $FD or $FE', () => {
    const c = cart(9, 128, 128);
    c.cpuWrite(0xb000, 4); // latch 0 = $FD
    c.cpuWrite(0xc000, 5); // latch 0 = $FE
    expect(chrWindows(c)[0]).toBe(20);
    c.ppuAddress(0x0fd8, 0);
    expect(chrWindows(c)[0]).toBe(16);
    c.ppuAddress(0x0fe8, 0);
    expect(chrWindows(c)[0]).toBe(20);
    expect(prgWindows(c)).toEqual([0, 13, 14, 15]);
  });

  it('keeps battery RAM, marks it changed, and loads .sav data', () => {
    const c = cart(1, 128, 0, { battery: true });
    expect(c.saveData).not.toBeNull();
    c.cpuWrite(0x6000, 0x42);
    expect(c.batteryDirty).toBe(true);
    expect(c.cpuRead(0x6000)).toBe(0x42);
    c.loadSaveData(new Uint8Array([1, 2, 3]));
    expect([c.cpuRead(0x6000), c.cpuRead(0x6002), c.cpuRead(0x6003)]).toEqual([1, 3, 0]);
    expect(cart(1, 128).saveData).toBeNull();
  });
});
