import type { Apu } from './apu/apu';
import type { Cartridge } from './cart/cartridge';
import type { Cpu2A03, CpuBus } from './cpu/cpu2a03';
import type { Controllers } from './io/controllers';
import type { Ppu } from './ppu/ppu';

export const RAM_SIZE = 0x800;
/** PPU dots per CPU cycle, in fifths: 3 on NTSC, 3.2 on PAL. */
export const PPU_FIFTHS = { ntsc: 15, pal: 16 } as const;
const PPU_FIFTHS_BEFORE_ACCESS = 10;

/**
 * The CPU's address space: 2K of RAM mirrored to $1FFF, the PPU's eight
 * registers mirrored to $3FFF, the APU and controller ports at $4000-$4017,
 * and the cartridge from $4020. Every access is one CPU cycle, and runs the
 * PPU and APU for that cycle; OAM and DMC DMA take their cycles here too.
 */
export class NesBus implements CpuBus {
  readonly ram = new Uint8Array(RAM_SIZE);
  cartridge: Cartridge | null = null;
  /** Wired up by the machine, which owns the CPU. */
  cpu: Cpu2A03 | null = null;
  cycles = 0;
  /** The last value on the data bus: what reads of unmapped addresses return. */
  openBus = 0;
  ppuFifths: number = PPU_FIFTHS.ntsc;
  private ppuPhase = 0;

  // DMA: a request halts the CPU on its next read; the DMA unit then alternates "get" and "put" cycles.
  private needHalt = false;
  private needDummyRead = false;
  private dmcDmaRunning = false;
  private spriteDmaRunning = false;
  private spriteDmaPage = 0;

  constructor(
    private readonly ppu: Ppu,
    private readonly apu: Apu,
    private readonly controllers: Controllers,
  ) {}

  read(addr: number): number {
    if (this.needHalt) this.runDma(addr);
    this.startCycle();
    const value = this.readMemory(addr);
    this.endCycle();
    return value;
  }

  write(addr: number, value: number): void {
    this.startCycle();
    this.writeMemory(addr, value);
    this.endCycle();
  }

  /** The CPU's access lands about two PPU dots into its cycle; the rest of the cycle's dots follow it. */
  private startCycle(): void {
    this.cycles++;
    this.runPpu(PPU_FIFTHS_BEFORE_ACCESS);
    this.apu.tick();
    if (this.apu.dmc.needsByte && !this.dmcDmaRunning) {
      this.dmcDmaRunning = true;
      this.needHalt = this.needDummyRead = true;
    }
  }

  /** The end of a CPU cycle: the rest of the PPU's dots, then the interrupt lines as they now stand. */
  private endCycle(): void {
    this.runPpu(this.ppuFifths - PPU_FIFTHS_BEFORE_ACCESS);
    const cpu = this.cpu;
    if (cpu) {
      cpu.nmiLine = this.ppu.nmiOutput;
      cpu.irqLine = this.apu.irq || (this.cartridge?.irq ?? false);
    }
  }

  private runPpu(fifths: number): void {
    this.ppuPhase += fifths;
    while (this.ppuPhase >= 5) {
      this.ppuPhase -= 5;
      this.ppu.tick();
    }
  }

  /**
   * Runs pending DMA before the CPU's read of `addr`, which it holds up. Sprite
   * DMA (a write to $4014) copies 256 bytes to $2004 on alternate get/put
   * cycles; a DMC sample fetch needs a halt and a dummy cycle first (sprite
   * DMA cycles count as those), then takes a get cycle. While halted, the CPU
   * keeps repeating its read, which has side effects on some registers.
   */
  private runDma(addr: number): void {
    // Repeated reads of the controller ports don't happen on the console (the CPU drives them differently).
    const dummyReads = addr !== 0x4016 && addr !== 0x4017;
    this.startCycle();
    if (dummyReads) this.readMemory(addr);
    this.endCycle();
    this.needHalt = false;

    let spriteCycles = 0;
    let spriteAddr = 0;
    let value = 0;
    while (this.dmcDmaRunning || this.spriteDmaRunning) {
      const getCycle = (this.cycles & 1) === 0;
      if (this.needHalt) this.needHalt = false;
      else if (this.needDummyRead) this.needDummyRead = false;
      else if (getCycle && this.dmcDmaRunning) {
        this.startCycle();
        const sample = this.readMemory(this.apu.dmc.address);
        this.endCycle();
        this.dmcDmaRunning = false;
        this.apu.dmc.receive(sample);
        continue;
      }
      this.startCycle();
      if (getCycle && this.spriteDmaRunning && (spriteCycles & 1) === 0) {
        value = this.readMemory((this.spriteDmaPage << 8) | spriteAddr);
        spriteAddr = (spriteAddr + 1) & 0xff;
        spriteCycles++;
      } else if (!getCycle && this.spriteDmaRunning && spriteCycles & 1) {
        this.ppu.writeOam(value);
        if (++spriteCycles === 512) this.spriteDmaRunning = false;
      } else if (dummyReads) {
        this.readMemory(addr);
      }
      this.endCycle();
    }
  }

  private readMemory(addr: number): number {
    let value: number;
    if (addr < 0x2000) {
      value = this.ram[addr & 0x7ff];
    } else if (addr < 0x4000) {
      value = this.ppu.readRegister(addr);
    } else if (addr < 0x4020) {
      if (addr === 0x4015) {
        // The status read doesn't drive bit 5, and doesn't change the data bus.
        return this.apu.readStatus() | (this.openBus & 0x20);
      }
      if (addr === 0x4016 || addr === 0x4017) value = this.controllers.read(addr === 0x4016 ? 0 : 1) | (this.openBus & 0xe0);
      else value = this.openBus;
    } else {
      const cart = this.cartridge?.cpuRead(addr) ?? -1;
      value = cart < 0 ? this.openBus : cart;
    }
    this.openBus = value;
    return value;
  }

  private writeMemory(addr: number, value: number): void {
    this.openBus = value;
    if (addr < 0x2000) {
      this.ram[addr & 0x7ff] = value;
    } else if (addr < 0x4000) {
      this.ppu.writeRegister(addr, value);
    } else if (addr < 0x4020) {
      if (addr === 0x4014) {
        this.spriteDmaPage = value;
        this.spriteDmaRunning = this.needHalt = true;
      }
      else if (addr === 0x4016) this.controllers.write(value);
      else if (addr < 0x4018) this.apu.writeRegister(addr, value);
    } else if (this.cartridge) {
      this.cartridge.cpuCycle = this.cycles;
      this.cartridge.cpuWrite(addr, value);
    }
  }
}
