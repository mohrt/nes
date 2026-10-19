import { Cartridge } from '../cartridge';

/** A rise of PPU A12 only counts after it has been low this long (the MMC3 filters out the short dips between sprite fetches). */
const A12_FILTER_DOTS = 10;

/**
 * Mapper 4 (Nintendo MMC3, the TxROM boards): two switchable 8K PRG banks,
 * 2K and 1K CHR banks, and a scanline counter clocked by rises of PPU A12,
 * which raises an IRQ when it reaches zero.
 */
export class Mmc3 extends Cartridge {
  override readonly watchesPpu: boolean = true;
  bankSelect = 0;
  readonly registers = new Uint8Array(8);
  irqLatch = 0;
  irqCounter = 0;
  irqReload = false;
  irqEnabled = false;
  a12High = false;
  a12LowSince = 0;

  override reset(): void {
    super.reset();
    this.registers.set([0, 2, 4, 5, 6, 7, 0, 1]);
    this.bankSelect = 0;
    this.irqLatch = this.irqCounter = 0;
    this.irqReload = this.irqEnabled = false;
    this.a12High = false;
    this.a12LowSince = 0;
    this.update();
  }

  protected override writeRegister(addr: number, value: number): void {
    switch (addr & 0xe001) {
      case 0x8000: this.bankSelect = value; this.update(); break;
      case 0x8001: this.registers[this.bankSelect & 7] = value; this.update(); break;
      case 0xa000:
        if (this.headerMirroring !== 'four-screen') this.setMirroring(value & 1 ? 'horizontal' : 'vertical');
        break;
      case 0xa001:
        this.prgRamEnabled = (value & 0x80) !== 0;
        this.prgRamWritable = (value & 0x40) === 0;
        break;
      case 0xc000: this.irqLatch = value; break;
      case 0xc001: this.irqCounter = 0; this.irqReload = true; break;
      case 0xe000: this.irqEnabled = false; this.irq = false; break;
      case 0xe001: this.irqEnabled = true; break;
    }
  }

  protected update(): void {
    const r = this.registers;
    if (this.bankSelect & 0x40) {
      this.setPrg8k(0, -2);
      this.setPrg8k(2, r[6]);
    } else {
      this.setPrg8k(0, r[6]);
      this.setPrg8k(2, -2);
    }
    this.setPrg8k(1, r[7]);
    this.setPrg8k(3, -1);

    const flip = this.bankSelect & 0x80 ? 4 : 0;
    this.setChr1k(0 ^ flip, r[0] & 0xfe);
    this.setChr1k(1 ^ flip, r[0] | 1);
    this.setChr1k(2 ^ flip, r[1] & 0xfe);
    this.setChr1k(3 ^ flip, r[1] | 1);
    for (let i = 0; i < 4; i++) this.setChr1k((4 + i) ^ flip, r[2 + i]);
  }

  override ppuAddress(addr: number, dots: number): void {
    if (addr & 0x1000) {
      if (!this.a12High) {
        this.a12High = true;
        if (dots - this.a12LowSince >= A12_FILTER_DOTS) this.clockCounter();
      }
    } else if (this.a12High) {
      this.a12High = false;
      this.a12LowSince = dots;
    }
  }

  private clockCounter(): void {
    if (this.irqCounter === 0 || this.irqReload) {
      this.irqCounter = this.irqLatch;
      this.irqReload = false;
    } else {
      this.irqCounter--;
    }
    if (this.irqCounter === 0 && this.irqEnabled) this.irq = true;
  }
}

/** Mapper 206 (Namco 108 / DxROM): the MMC3's banking without its modes, mirroring control or IRQ. */
export class Namco108 extends Mmc3 {
  protected override writeRegister(addr: number, value: number): void {
    if (addr < 0xa000) super.writeRegister(addr, addr & 1 ? value & 0x3f : value & 0x07);
  }
}
