import type { Mirroring, RomInfo } from './ines';

export type NametableLayout = Mirroring | 'single-a' | 'single-b';

const PRG_WINDOW = 0x2000;
const CHR_WINDOW = 0x0400;
const NAMETABLE = 0x0400;

const LAYOUTS: Record<NametableLayout, readonly number[]> = {
  horizontal: [0, 0, 1, 1],
  vertical: [0, 1, 0, 1],
  'single-a': [0, 0, 0, 0],
  'single-b': [1, 1, 1, 1],
  'four-screen': [0, 1, 2, 3],
};

/**
 * A cartridge: PRG ROM seen by the CPU at $8000-$FFFF in four 8K windows,
 * CHR ROM or RAM seen by the PPU at $0000-$1FFF in eight 1K windows, optional
 * PRG RAM at $6000-$7FFF, and the wiring of the PPU's nametables. Mappers
 * subclass this and move the windows when the game writes to their registers.
 */
export class Cartridge {
  readonly prgRom: Uint8Array;
  readonly chrRom: Uint8Array;
  /** CHR RAM, or empty when the cartridge has CHR ROM. */
  readonly chrRam: Uint8Array;
  readonly prgRam: Uint8Array;
  /** Whichever of chrRom or chrRam the PPU sees (not saved: it is one of them). */
  protected readonly chr: Uint8Array;
  readonly mapper: number;
  readonly battery: boolean;
  /** The mirroring the header gives (soldered on boards without mapper control). */
  readonly headerMirroring: Mirroring;

  /** Offsets into prgRom of the 8K windows at $8000, $A000, $C000 and $E000. */
  readonly prgBanks = new Int32Array(4);
  /** Offsets into the CHR memory of the 1K windows at $0000-$1FFF. */
  readonly chrBanks = new Int32Array(8);
  /** Offsets into the PPU's nametable RAM of $2000, $2400, $2800 and $2C00. */
  readonly nametables = new Int32Array(4);
  prgRamEnabled = true;
  prgRamWritable = true;
  /** The cartridge's IRQ output. */
  irq = false;
  /** Set when battery-backed RAM changes, so the page knows to save it. */
  batteryDirty = false;
  /** The CPU cycle of the current write, for mappers that notice back-to-back writes. Set by the bus. */
  cpuCycle = 0;
  /** Mappers that watch the PPU's address bus (MMC2, MMC3) set this, so the PPU tells them about every fetch. */
  readonly watchesPpu: boolean = false;

  constructor(info: RomInfo) {
    this.mapper = info.mapper;
    this.prgRom = info.prg;
    this.chrRom = info.chr;
    this.chrRam = new Uint8Array(info.chr.length === 0 ? info.chrRamSize : 0);
    this.chr = info.chr.length > 0 ? info.chr : this.chrRam;
    this.prgRam = new Uint8Array(info.prgRamSize);
    this.battery = info.battery;
    this.headerMirroring = info.mirroring;
  }

  /** Power on / reset: the mapper's registers to their initial state. */
  reset(): void {
    this.irq = false;
    this.prgRamEnabled = this.prgRamWritable = true;
    this.setPrg32k(0);
    this.setChr8k(0);
    this.setMirroring(this.headerMirroring);
  }

  // --- Bank switching helpers (bank numbers wrap around the ROM size) ----------

  protected setPrg8k(slot: number, bank: number): void {
    const banks = this.prgRom.length / PRG_WINDOW;
    this.prgBanks[slot] = (((bank % banks) + banks) % banks) * PRG_WINDOW;
  }

  protected setPrg16k(slot: 0 | 1, bank: number): void {
    this.setPrg8k(slot * 2, bank * 2);
    this.setPrg8k(slot * 2 + 1, bank * 2 + 1);
  }

  protected setPrg32k(bank: number): void {
    for (let i = 0; i < 4; i++) this.setPrg8k(i, bank * 4 + i);
  }

  protected get prg16kBanks(): number {
    return Math.max(1, this.prgRom.length / 0x4000);
  }

  protected setChr1k(slot: number, bank: number): void {
    const banks = Math.max(1, this.chr.length / CHR_WINDOW);
    this.chrBanks[slot] = (((bank % banks) + banks) % banks) * CHR_WINDOW;
  }

  protected setChr2k(slot: number, bank: number): void {
    this.setChr1k(slot * 2, bank * 2);
    this.setChr1k(slot * 2 + 1, bank * 2 + 1);
  }

  protected setChr4k(slot: 0 | 1, bank: number): void {
    for (let i = 0; i < 4; i++) this.setChr1k(slot * 4 + i, bank * 4 + i);
  }

  protected setChr8k(bank: number): void {
    for (let i = 0; i < 8; i++) this.setChr1k(i, bank * 8 + i);
  }

  protected setMirroring(layout: NametableLayout): void {
    // Four-screen boards carry their own 2K of nametable RAM; the PPU keeps 4K so it can be addressed alike.
    LAYOUTS[layout].forEach((table, i) => (this.nametables[i] = table * NAMETABLE));
  }

  // --- CPU side ($4020-$FFFF) -----------------------------------------------------

  /** A byte for the CPU, or -1 where the cartridge doesn't drive the bus (open bus). */
  cpuRead(addr: number): number {
    if (addr >= 0x8000) return this.prgRom[this.prgBanks[(addr >> 13) & 3] + (addr & 0x1fff)];
    if (addr >= 0x6000 && this.prgRamEnabled && this.prgRam.length > 0) return this.prgRam[(addr - 0x6000) % this.prgRam.length];
    return -1;
  }

  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x8000) {
      this.writeRegister(addr, value);
    } else if (addr >= 0x6000) {
      this.writeLow(addr, value);
    }
  }

  /** Writes to $6000-$7FFF: PRG RAM, unless a mapper has registers there. */
  protected writeLow(addr: number, value: number): void {
    if (!this.prgRamEnabled || !this.prgRamWritable || this.prgRam.length === 0) return;
    const offset = (addr - 0x6000) % this.prgRam.length;
    if (this.prgRam[offset] === value) return;
    this.prgRam[offset] = value;
    if (this.battery) this.batteryDirty = true;
  }

  /** Writes to $8000-$FFFF: the mapper's registers. A plain board ignores them. */
  protected writeRegister(_addr: number, _value: number): void {}

  // --- PPU side ($0000-$1FFF) -----------------------------------------------------

  ppuRead(addr: number): number {
    return this.chr[this.chrBanks[addr >> 10] + (addr & 0x3ff)];
  }

  ppuWrite(addr: number, value: number): void {
    if (this.chrRam.length > 0) this.chrRam[this.chrBanks[addr >> 10] + (addr & 0x3ff)] = value;
  }

  /** Called with every address the PPU puts on its bus (only if `watchesPpu`), and the PPU's dot count. */
  ppuAddress(_addr: number, _dots: number): void {}

  /** Battery RAM as it should be saved, or null if the game has none. */
  get saveData(): Uint8Array | null {
    return this.battery && this.prgRam.length > 0 ? this.prgRam : null;
  }

  /** Loads a save (e.g. from a .sav file); shorter or longer saves fill what fits. */
  loadSaveData(data: Uint8Array): void {
    this.prgRam.fill(0);
    this.prgRam.set(data.subarray(0, this.prgRam.length));
    this.batteryDirty = false;
  }
}
