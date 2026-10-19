import { Apu } from './apu/apu';
import { NesBus, PPU_FIFTHS } from './bus';
import type { Cartridge } from './cart/cartridge';
import type { Region } from './cart/ines';
import { Cpu2A03 } from './cpu/cpu2a03';
import { Controllers } from './io/controllers';
import { Ppu } from './ppu/ppu';
import { captureState, restoreState, type StateNode } from './state/snapshot';

/** The CPU runs at the master clock divided by 12 (NTSC) or 16 (PAL). */
export const CPU_HZ: Record<Region, number> = { ntsc: 21_477_272 / 12, pal: 26_601_712 / 16 };
export const LINES_PER_FRAME: Record<Region, number> = { ntsc: 262, pal: 312 };
/** Turbo buttons press and release every this many frames (15 presses a second at 60 Hz). */
const TURBO_FRAMES = 2;

/**
 * The whole console: the 2A03 (CPU and APU), the 2C02 PPU, 2K of RAM, two
 * controller ports and a cartridge. The PPU's vertical blank drives the
 * CPU's NMI; the APU and the cartridge share its IRQ line.
 */
export class Nes {
  readonly ppu = new Ppu();
  readonly apu = new Apu();
  readonly controllers = new Controllers();
  readonly bus = new NesBus(this.ppu, this.apu, this.controllers);
  readonly cpu = new Cpu2A03(this.bus);
  region: Region = 'ntsc';
  /** Called with each finished picture (9-bit colours, 256x240). */
  onFrame: (framebuffer: Uint16Array) => void = () => {};

  constructor() {
    this.bus.cpu = this.cpu;
    this.setRegion('ntsc');
  }

  get clockHz(): number {
    return CPU_HZ[this.region];
  }

  get cartridge(): Cartridge | null {
    return this.bus.cartridge;
  }

  /** Changing cartridges means switching off first. */
  insertCartridge(cartridge: Cartridge | null): void {
    this.bus.cartridge = cartridge;
    this.ppu.cartridge = cartridge;
    this.powerOn();
  }

  setRegion(region: Region): void {
    this.region = region;
    this.ppu.linesPerFrame = LINES_PER_FRAME[region];
    this.ppu.pal = region === 'pal';
    if (this.ppu.scanline >= this.ppu.linesPerFrame) this.ppu.scanline = 0;
    this.bus.ppuFifths = PPU_FIFTHS[region];
    this.apu.setRegion(region);
  }

  /** Power on: everything back to its initial state, RAM cleared. */
  powerOn(): void {
    this.bus.ram.fill(0);
    this.ppu.powerOn();
    this.apu.powerOn();
    this.controllers.reset();
    this.cartridge?.reset();
    if (this.cartridge) this.cpu.powerOn();
  }

  /** The console's reset button: the CPU, PPU and APU restart; RAM and the cartridge keep their contents. */
  pressReset(): void {
    if (!this.cartridge) return;
    this.ppu.reset();
    this.apu.reset();
    this.cpu.reset();
  }

  /** Runs whole instructions for at least `cycles` CPU cycles; returns how many ran. */
  runCycles(cycles: number): number {
    if (!this.cartridge) return cycles;
    const start = this.bus.cycles;
    const end = start + cycles;
    while (this.bus.cycles < end) {
      this.cpu.step();
      if (this.ppu.frameReady) this.finishFrame();
    }
    return this.bus.cycles - start;
  }

  /** Runs until the next picture is complete. */
  runFrame(): void {
    if (!this.cartridge) return;
    while (!this.ppu.frameReady) this.cpu.step();
    this.finishFrame();
  }

  private finishFrame(): void {
    this.ppu.frameReady = false;
    this.controllers.turboOn = Math.floor(this.ppu.frames / TURBO_FRAMES) % 2 === 0;
    this.onFrame(this.ppu.framebuffer);
  }

  /** Everything in the console except the cartridge ROM (bank switching state and cartridge RAM included). */
  saveState(): StateNode {
    return captureState(this);
  }

  /** Restores a saved state; the same cartridge must already be in. */
  loadState(state: StateNode): void {
    restoreState(this, state);
    this.setRegion(this.region);
  }
}
