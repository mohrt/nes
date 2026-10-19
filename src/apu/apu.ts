import type { Region } from '../cart/ines';
import { DMC_PERIODS, Dmc, NOISE_PERIODS, Noise, Pulse, Triangle } from './channels';
import { AudioMixer } from './mixer';

/** Frame counter steps in CPU cycles: three quarter frames, the last step, and the sequence length. */
const FRAME_STEPS: Record<Region, { four: number[]; five: number[] }> = {
  ntsc: { four: [7457, 14913, 22371, 29829, 29830], five: [7457, 14913, 22371, 37281, 37282] },
  pal: { four: [8313, 16627, 24939, 33253, 33254], five: [8313, 16627, 24939, 41565, 41566] },
};

/** The 2A03's non-linear DAC, as lookup tables (from the NESdev wiki's mixer approximation). */
const PULSE_TABLE = Float32Array.from({ length: 31 }, (_, n) => (n === 0 ? 0 : 95.52 / (8128 / n + 100)));
const TND_TABLE = Float32Array.from({ length: 203 }, (_, n) => (n === 0 ? 0 : 163.67 / (24329 / n + 100)));

/**
 * The 2A03's audio unit: two pulse channels, a triangle, noise and the DMC,
 * stepped by the frame counter, which can also raise an IRQ. Run one CPU
 * cycle at a time; the mixed output goes to the AudioMixer.
 */
export class Apu {
  readonly pulse1 = new Pulse(true);
  readonly pulse2 = new Pulse(false);
  readonly triangle = new Triangle();
  readonly noise = new Noise(NOISE_PERIODS.ntsc);
  readonly dmc = new Dmc(DMC_PERIODS.ntsc);
  readonly mixer = new AudioMixer();

  region: Region = 'ntsc';
  fiveStep = false;
  irqInhibit = false;
  frameIrq = false;
  frameCycle = 0;
  /** Cycles until a $4017 write restarts the sequence (0 when none is pending). */
  resetDelay = 0;
  /** The pulse channels step on every other CPU cycle. */
  oddCycle = false;
  /** The reset button makes the APU write this again; power on starts from 0. */
  lastFrameCounterWrite = 0;

  setRegion(region: Region): void {
    this.region = region;
    this.noise.periods = NOISE_PERIODS[region];
    this.dmc.periods = DMC_PERIODS[region];
  }

  get irq(): boolean {
    return this.frameIrq || this.dmc.irq;
  }

  powerOn(): void {
    this.lastFrameCounterWrite = 0;
    this.reset();
  }

  /** The reset button: channels silenced, and the frame counter set up as it last was. */
  reset(): void {
    this.writeRegister(0x4015, 0);
    this.writeRegister(0x4017, this.lastFrameCounterWrite);
    this.frameCycle = 0;
    this.resetDelay = 0;
    this.frameIrq = false;
    this.dmc.irq = false;
  }

  readStatus(): number {
    const value =
      (this.pulse1.length > 0 ? 0x01 : 0) |
      (this.pulse2.length > 0 ? 0x02 : 0) |
      (this.triangle.length > 0 ? 0x04 : 0) |
      (this.noise.length > 0 ? 0x08 : 0) |
      (this.dmc.bytesRemaining > 0 ? 0x10 : 0) |
      (this.frameIrq ? 0x40 : 0) |
      (this.dmc.irq ? 0x80 : 0);
    this.frameIrq = false;
    return value;
  }

  writeRegister(addr: number, value: number): void {
    if (addr < 0x4004) this.pulse1.write(addr & 3, value);
    else if (addr < 0x4008) this.pulse2.write(addr & 3, value);
    else if (addr < 0x400c) this.triangle.write(addr & 3, value);
    else if (addr < 0x4010) this.noise.write(addr & 3, value);
    else if (addr < 0x4014) this.dmc.write(addr & 3, value);
    else if (addr === 0x4015) {
      this.pulse1.setEnabled((value & 0x01) !== 0);
      this.pulse2.setEnabled((value & 0x02) !== 0);
      this.triangle.setEnabled((value & 0x04) !== 0);
      this.noise.setEnabled((value & 0x08) !== 0);
      this.dmc.setEnabled((value & 0x10) !== 0);
    } else if (addr === 0x4017) {
      this.lastFrameCounterWrite = value;
      this.fiveStep = (value & 0x80) !== 0;
      this.irqInhibit = (value & 0x40) !== 0;
      if (this.irqInhibit) this.frameIrq = false;
      // The sequence restarts 3 or 4 cycles later, depending on where in the APU's two-cycle beat the write fell.
      this.resetDelay = this.oddCycle ? 4 : 3;
    }
  }

  /** Runs one CPU cycle. */
  tick(): void {
    this.stepFrameCounter();
    this.oddCycle = !this.oddCycle;
    if (this.oddCycle) {
      this.pulse1.clockTimer();
      this.pulse2.clockTimer();
    }
    this.triangle.clockTimer();
    this.noise.clockTimer();
    this.dmc.clockTimer();
    this.mixer.add(
      PULSE_TABLE[this.pulse1.output + this.pulse2.output] +
        TND_TABLE[3 * this.triangle.output + 2 * this.noise.output + this.dmc.level],
    );
  }

  private stepFrameCounter(): void {
    if (this.resetDelay > 0 && --this.resetDelay === 0) {
      this.frameCycle = 0;
      if (this.fiveStep) {
        this.quarterFrame();
        this.halfFrame();
      }
      return;
    }
    const cycle = ++this.frameCycle;
    const steps = FRAME_STEPS[this.region][this.fiveStep ? 'five' : 'four'];
    if (cycle === steps[0] || cycle === steps[2]) {
      this.quarterFrame();
    } else if (cycle === steps[1] || cycle === steps[3]) {
      this.quarterFrame();
      this.halfFrame();
    }
    if (!this.fiveStep && !this.irqInhibit && cycle >= steps[3] - 1) this.frameIrq = true;
    if (cycle >= steps[4]) this.frameCycle = 0;
  }

  private quarterFrame(): void {
    this.pulse1.envelope.clock();
    this.pulse2.envelope.clock();
    this.triangle.clockQuarterFrame();
    this.noise.envelope.clock();
  }

  private halfFrame(): void {
    this.pulse1.clockHalfFrame();
    this.pulse2.clockHalfFrame();
    this.triangle.clockHalfFrame();
    this.noise.clockHalfFrame();
  }
}
