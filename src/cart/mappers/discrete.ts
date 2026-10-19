import { Cartridge } from '../cartridge';

// Boards built from a latch or two instead of a mapper chip: one register, written anywhere in $8000-$FFFF.

/** Mapper 2 (UNROM, UOROM): a switchable 16K bank at $8000, the last bank fixed at $C000. */
export class UxRom extends Cartridge {
  override reset(): void {
    super.reset();
    this.setPrg16k(0, 0);
    this.setPrg16k(1, -1);
  }

  protected override writeRegister(_addr: number, value: number): void {
    this.setPrg16k(0, value);
  }
}

/** Mapper 3 (CNROM): fixed PRG, a switchable 8K CHR bank. */
export class CnRom extends Cartridge {
  protected override writeRegister(_addr: number, value: number): void {
    this.setChr8k(value);
  }
}

/** Mapper 7 (AxROM): 32K PRG banks and a one-screen nametable chosen by bit 4. */
export class AxRom extends Cartridge {
  override reset(): void {
    super.reset();
    this.setMirroring('single-a');
  }

  protected override writeRegister(_addr: number, value: number): void {
    this.setPrg32k(value & 0x07);
    this.setMirroring(value & 0x10 ? 'single-b' : 'single-a');
  }
}

/** Mapper 11 (Color Dreams): 32K PRG in the low bits, 8K CHR in the high nibble. */
export class ColorDreams extends Cartridge {
  protected override writeRegister(_addr: number, value: number): void {
    this.setPrg32k(value & 0x03);
    this.setChr8k(value >> 4);
  }
}

/**
 * Mapper 34: BNROM (32K PRG banks, CHR RAM) or, with CHR ROM, AVE's NINA-001,
 * whose registers sit at $7FFD-$7FFF on top of its PRG RAM.
 */
export class Bnrom extends Cartridge {
  private get isNina(): boolean {
    return this.chrRom.length > 0x2000;
  }

  protected override writeRegister(_addr: number, value: number): void {
    if (!this.isNina) this.setPrg32k(value);
  }

  protected override writeLow(addr: number, value: number): void {
    super.writeLow(addr, value);
    if (!this.isNina) return;
    if (addr === 0x7ffd) this.setPrg32k(value & 0x01);
    else if (addr === 0x7ffe) this.setChr4k(0, value & 0x0f);
    else if (addr === 0x7fff) this.setChr4k(1, value & 0x0f);
  }
}

/** Mapper 66 (GxROM, MxROM): 32K PRG in bits 4-5, 8K CHR in bits 0-1. */
export class GxRom extends Cartridge {
  protected override writeRegister(_addr: number, value: number): void {
    this.setPrg32k((value >> 4) & 0x03);
    this.setChr8k(value & 0x03);
  }
}

/** Mapper 71 (Camerica / Codemasters): UNROM-like at $C000-$FFFF; Fire Hawk picks its nametable at $9000. */
export class Camerica extends Cartridge {
  override reset(): void {
    super.reset();
    this.setPrg16k(0, 0);
    this.setPrg16k(1, -1);
  }

  protected override writeRegister(addr: number, value: number): void {
    if (addr >= 0xc000) this.setPrg16k(0, value);
    else if (addr >= 0x9000 && addr < 0xa000) this.setMirroring(value & 0x10 ? 'single-b' : 'single-a');
  }
}
