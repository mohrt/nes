import type { RomInfo } from '../ines';
import { Cartridge } from '../cartridge';

const FD = 0xfd;
const FE = 0xfe;

/**
 * Mappers 9 and 10 (Nintendo MMC2, MMC4): each 4K half of CHR has two banks,
 * and the PPU fetching tile $FD or $FE in that half switches between them.
 * The MMC2 (Punch-Out!!) has an 8K PRG window; the MMC4 a 16K one and PRG RAM.
 */
export class Mmc2 extends Cartridge {
  override readonly watchesPpu: boolean = true;
  prgBank = 0;
  /** CHR banks for latch 0 = $FD, latch 0 = $FE, latch 1 = $FD, latch 1 = $FE. */
  readonly chrSelect = new Uint8Array(4);
  latch0 = FE;
  latch1 = FE;

  constructor(
    info: RomInfo,
    private readonly isMmc4: boolean,
  ) {
    super(info);
  }

  override reset(): void {
    super.reset();
    this.prgBank = 0;
    this.chrSelect.fill(0);
    this.latch0 = this.latch1 = FE;
    this.update();
  }

  protected override writeRegister(addr: number, value: number): void {
    switch (addr & 0xf000) {
      case 0xa000: this.prgBank = value & 0x0f; break;
      case 0xb000: this.chrSelect[0] = value & 0x1f; break;
      case 0xc000: this.chrSelect[1] = value & 0x1f; break;
      case 0xd000: this.chrSelect[2] = value & 0x1f; break;
      case 0xe000: this.chrSelect[3] = value & 0x1f; break;
      case 0xf000: this.setMirroring(value & 1 ? 'horizontal' : 'vertical'); return;
      default: return;
    }
    this.update();
  }

  private update(): void {
    if (this.isMmc4) {
      this.setPrg16k(0, this.prgBank);
      this.setPrg16k(1, -1);
    } else {
      this.setPrg8k(0, this.prgBank);
      this.setPrg8k(1, -3);
      this.setPrg8k(2, -2);
      this.setPrg8k(3, -1);
    }
    this.setChr4k(0, this.chrSelect[this.latch0 === FD ? 0 : 1]);
    this.setChr4k(1, this.chrSelect[this.latch1 === FD ? 2 : 3]);
  }

  override ppuAddress(addr: number): void {
    let latch0 = this.latch0;
    let latch1 = this.latch1;
    const row = addr & 0x1ff8;
    if (this.isMmc4 ? row === 0x0fd8 : addr === 0x0fd8) latch0 = FD;
    else if (this.isMmc4 ? row === 0x0fe8 : addr === 0x0fe8) latch0 = FE;
    else if (row === 0x1fd8) latch1 = FD;
    else if (row === 0x1fe8) latch1 = FE;
    else return;
    if (latch0 === this.latch0 && latch1 === this.latch1) return;
    this.latch0 = latch0;
    this.latch1 = latch1;
    this.update();
  }
}
