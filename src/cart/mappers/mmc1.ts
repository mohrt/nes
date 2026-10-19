import { Cartridge, type NametableLayout } from '../cartridge';

const LAYOUTS: NametableLayout[] = ['single-a', 'single-b', 'vertical', 'horizontal'];
/** SUROM and SXROM boards have 512K of PRG: CHR register bit 4 picks which 256K the CPU sees. */
const OUTER_PRG_BANKS = 16;

/**
 * Mapper 1 (Nintendo MMC1, the SxROM boards). Registers are loaded one bit
 * at a time through a 5-bit shift register; a write with bit 7 set resets it.
 */
export class Mmc1 extends Cartridge {
  shift = 0x10;
  control = 0x0c;
  chrBank0 = 0;
  chrBank1 = 0;
  prgBank = 0;
  /** The MMC1 ignores a write on the cycle right after another (read-modify-write instructions write twice). */
  lastWriteCycle = -2;

  override reset(): void {
    super.reset();
    this.shift = 0x10;
    this.control = 0x0c;
    this.chrBank0 = this.chrBank1 = this.prgBank = 0;
    this.update();
  }

  protected override writeRegister(addr: number, value: number): void {
    const backToBack = this.cpuCycle === this.lastWriteCycle + 1;
    this.lastWriteCycle = this.cpuCycle;
    if (value & 0x80) {
      this.shift = 0x10;
      this.control |= 0x0c;
      this.update();
      return;
    }
    if (backToBack) return;
    const full = this.shift & 1;
    this.shift = (this.shift >> 1) | ((value & 1) << 4);
    if (!full) return;
    const data = this.shift;
    this.shift = 0x10;
    switch ((addr >> 13) & 3) {
      case 0: this.control = data; break;
      case 1: this.chrBank0 = data; break;
      case 2: this.chrBank1 = data; break;
      case 3: this.prgBank = data; break;
    }
    this.update();
  }

  private update(): void {
    this.setMirroring(LAYOUTS[this.control & 3]);

    if (this.control & 0x10) {
      this.setChr4k(0, this.chrBank0);
      this.setChr4k(1, this.chrBank1);
    } else {
      this.setChr8k(this.chrBank0 >> 1);
    }

    const outer = this.prg16kBanks > OUTER_PRG_BANKS ? this.chrBank0 & 0x10 : 0;
    const bank = this.prgBank & 0x0f;
    switch ((this.control >> 2) & 3) {
      case 0:
      case 1:
        this.setPrg16k(0, outer | (bank & 0x0e));
        this.setPrg16k(1, outer | (bank & 0x0e) | 1);
        break;
      case 2:
        this.setPrg16k(0, outer);
        this.setPrg16k(1, outer | bank);
        break;
      case 3:
        this.setPrg16k(0, outer | bank);
        this.setPrg16k(1, outer | (OUTER_PRG_BANKS - 1));
        break;
    }
    this.prgRamEnabled = (this.prgBank & 0x10) === 0;
  }
}
