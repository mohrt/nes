import type { Region } from './cart/ines';
import { Nes } from './nes';
import type { Screen } from './render/screen';

/** Longest gap we catch up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;

/** Glues the machine to the screen and the speakers, and runs it in step with real time. */
export class Emulator {
  readonly machine = new Nes();
  private cycleDebt = 0;
  private audioRate = 48000;
  private idleShown = false;

  constructor(private readonly screen: Screen) {
    this.machine.onFrame = (frame) => screen.capture(frame);
    this.updateAudioRate();
  }

  get canRun(): boolean {
    return this.machine.cartridge !== null;
  }

  setAudioRate(rate: number): void {
    this.audioRate = rate;
    this.updateAudioRate();
  }

  setRegion(region: Region): void {
    if (region === this.machine.region) return;
    this.machine.setRegion(region);
    this.updateAudioRate();
  }

  /** Follows the TV system of a restored save state. */
  restored(): void {
    this.updateAudioRate();
    this.resetTiming();
  }

  private updateAudioRate(): void {
    this.machine.apu.mixer.setRates(this.machine.clockHz, this.audioRate);
  }

  /** Forgets time owed, e.g. after a pause, so the machine doesn't race to catch up. */
  resetTiming(): void {
    this.cycleDebt = 0;
  }

  /** Runs the machine for `elapsedMs` of real time (no more than MAX_CATCH_UP_MS). */
  run(elapsedMs: number): void {
    if (!this.canRun) {
      if (!this.idleShown) this.screen.showIdle();
      this.idleShown = true;
      return;
    }
    this.idleShown = false;
    this.cycleDebt += (Math.min(elapsedMs, MAX_CATCH_UP_MS) * this.machine.clockHz) / 1000;
    if (this.cycleDebt > 0) this.cycleDebt -= this.machine.runCycles(Math.ceil(this.cycleDebt));
  }

  takeAudioSamples(): Float32Array {
    return this.machine.apu.mixer.takeSamples();
  }
}
