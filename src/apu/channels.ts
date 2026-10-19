/** Length counter loads, indexed by the top five bits of a channel's fourth register. */
export const LENGTHS = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
];

const DUTIES = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [1, 0, 0, 1, 1, 1, 1, 1],
];

const TRIANGLE = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** Noise and DMC periods in CPU cycles. */
export const NOISE_PERIODS = {
  ntsc: [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068],
  pal: [4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778],
};
export const DMC_PERIODS = {
  ntsc: [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54],
  pal: [398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50],
};

/** The volume envelope shared by the pulse and noise channels. */
export class Envelope {
  start = false;
  loop = false;
  constant = false;
  volume = 0;
  divider = 0;
  decay = 0;

  write(value: number): void {
    this.loop = (value & 0x20) !== 0;
    this.constant = (value & 0x10) !== 0;
    this.volume = value & 0x0f;
  }

  clock(): void {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.volume;
    } else if (this.divider === 0) {
      this.divider = this.volume;
      if (this.decay > 0) this.decay--;
      else if (this.loop) this.decay = 15;
    } else {
      this.divider--;
    }
  }

  get level(): number {
    return this.constant ? this.volume : this.decay;
  }
}

export class Pulse {
  enabled = false;
  length = 0;
  readonly envelope = new Envelope();
  duty = 0;
  step = 0;
  period = 0;
  timer = 0;
  sweepEnabled = false;
  sweepPeriod = 0;
  sweepNegate = false;
  sweepShift = 0;
  sweepReload = false;
  sweepDivider = 0;

  /** Pulse 1 negates its sweep with ones' complement, pulse 2 with two's. */
  constructor(private readonly onesComplement: boolean) {}

  write(reg: number, value: number): void {
    switch (reg) {
      case 0:
        this.duty = value >> 6;
        this.envelope.write(value);
        break;
      case 1:
        this.sweepEnabled = (value & 0x80) !== 0;
        this.sweepPeriod = (value >> 4) & 7;
        this.sweepNegate = (value & 0x08) !== 0;
        this.sweepShift = value & 7;
        this.sweepReload = true;
        break;
      case 2:
        this.period = (this.period & 0x700) | value;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((value & 7) << 8);
        if (this.enabled) this.length = LENGTHS[value >> 3];
        this.step = 0;
        this.envelope.start = true;
        break;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.length = 0;
  }

  /** Clocked every other CPU cycle. */
  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.period;
      this.step = (this.step + 1) & 7;
    } else {
      this.timer--;
    }
  }

  private get sweepTarget(): number {
    const change = this.period >> this.sweepShift;
    return this.sweepNegate ? this.period - change - (this.onesComplement ? 1 : 0) : this.period + change;
  }

  private get muted(): boolean {
    return this.period < 8 || this.sweepTarget > 0x7ff;
  }

  clockHalfFrame(): void {
    if (!this.envelope.loop && this.length > 0) this.length--;
    if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0 && !this.muted) {
      this.period = Math.max(0, this.sweepTarget);
    }
    if (this.sweepDivider === 0 || this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    } else {
      this.sweepDivider--;
    }
  }

  get output(): number {
    if (this.length === 0 || this.muted || DUTIES[this.duty][this.step] === 0) return 0;
    return this.envelope.level;
  }
}

export class Triangle {
  enabled = false;
  length = 0;
  control = false;
  linearReloadValue = 0;
  linearCounter = 0;
  linearReload = false;
  period = 0;
  timer = 0;
  step = 0;

  write(reg: number, value: number): void {
    switch (reg) {
      case 0:
        this.control = (value & 0x80) !== 0;
        this.linearReloadValue = value & 0x7f;
        break;
      case 2:
        this.period = (this.period & 0x700) | value;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((value & 7) << 8);
        if (this.enabled) this.length = LENGTHS[value >> 3];
        this.linearReload = true;
        break;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.length = 0;
  }

  /** Clocked every CPU cycle. */
  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.period;
      if (this.length > 0 && this.linearCounter > 0) this.step = (this.step + 1) & 31;
    } else {
      this.timer--;
    }
  }

  clockQuarterFrame(): void {
    if (this.linearReload) this.linearCounter = this.linearReloadValue;
    else if (this.linearCounter > 0) this.linearCounter--;
    if (!this.control) this.linearReload = false;
  }

  clockHalfFrame(): void {
    if (!this.control && this.length > 0) this.length--;
  }

  get output(): number {
    return TRIANGLE[this.step];
  }
}

export class Noise {
  enabled = false;
  length = 0;
  readonly envelope = new Envelope();
  shortMode = false;
  period = 4;
  timer = 0;
  shift = 1;

  constructor(public periods: number[]) {}

  write(reg: number, value: number): void {
    switch (reg) {
      case 0:
        this.envelope.write(value);
        break;
      case 2:
        this.shortMode = (value & 0x80) !== 0;
        this.period = this.periods[value & 0x0f];
        break;
      case 3:
        if (this.enabled) this.length = LENGTHS[value >> 3];
        this.envelope.start = true;
        break;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.length = 0;
  }

  /** Clocked every CPU cycle. */
  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.period - 1;
      const feedback = (this.shift ^ (this.shift >> (this.shortMode ? 6 : 1))) & 1;
      this.shift = (this.shift >> 1) | (feedback << 14);
    } else {
      this.timer--;
    }
  }

  clockHalfFrame(): void {
    if (!this.envelope.loop && this.length > 0) this.length--;
  }

  get output(): number {
    return this.length === 0 || this.shift & 1 ? 0 : this.envelope.level;
  }
}

/** The delta modulation channel: plays 1-bit delta samples it reads from cartridge memory by DMA. */
export class Dmc {
  irqEnabled = false;
  loop = false;
  period = 428;
  timer = 0;
  level = 0;
  sampleAddress = 0xc000;
  sampleLength = 1;
  address = 0xc000;
  bytesRemaining = 0;
  sampleBuffer = 0;
  bufferEmpty = true;
  shiftRegister = 0;
  bitsRemaining = 8;
  silent = true;
  irq = false;

  constructor(public periods: number[]) {}

  write(reg: number, value: number): void {
    switch (reg) {
      case 0:
        this.irqEnabled = (value & 0x80) !== 0;
        if (!this.irqEnabled) this.irq = false;
        this.loop = (value & 0x40) !== 0;
        this.period = this.periods[value & 0x0f];
        break;
      case 1:
        this.level = value & 0x7f;
        break;
      case 2:
        this.sampleAddress = 0xc000 + value * 64;
        break;
      case 3:
        this.sampleLength = value * 16 + 1;
        break;
    }
  }

  setEnabled(enabled: boolean): void {
    this.irq = false;
    if (!enabled) this.bytesRemaining = 0;
    else if (this.bytesRemaining === 0) this.restart();
  }

  private restart(): void {
    this.address = this.sampleAddress;
    this.bytesRemaining = this.sampleLength;
  }

  /** True when the sample buffer is empty and there are bytes left to read: the machine should DMA one in. */
  get needsByte(): boolean {
    return this.bufferEmpty && this.bytesRemaining > 0;
  }

  /** The byte the DMA read from `address`. */
  receive(value: number): void {
    this.sampleBuffer = value;
    this.bufferEmpty = false;
    this.address = this.address === 0xffff ? 0x8000 : this.address + 1;
    if (--this.bytesRemaining === 0) {
      if (this.loop) this.restart();
      else if (this.irqEnabled) this.irq = true;
    }
  }

  /** Clocked every CPU cycle. */
  clockTimer(): void {
    if (this.timer > 0) {
      this.timer--;
      return;
    }
    this.timer = this.period - 1;
    if (!this.silent) {
      if (this.shiftRegister & 1) {
        if (this.level <= 125) this.level += 2;
      } else if (this.level >= 2) {
        this.level -= 2;
      }
    }
    this.shiftRegister >>= 1;
    if (--this.bitsRemaining === 0) {
      this.bitsRemaining = 8;
      if (this.bufferEmpty) {
        this.silent = true;
      } else {
        this.silent = false;
        this.shiftRegister = this.sampleBuffer;
        this.bufferEmpty = true;
      }
    }
  }
}
