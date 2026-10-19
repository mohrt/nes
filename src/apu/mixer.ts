/** A gentle high-pass that takes away the DC offset (the console's own output is AC-coupled). */
const DC_BLOCK = 0.995;
const GAIN = 0.9;

/**
 * Resamples the APU's output, one value per CPU cycle, to the audio device's
 * rate by averaging the cycles that fall in each sample.
 */
export class AudioMixer {
  private cyclesPerSample = 1;
  private position = 0;
  private sum = 0;
  private count = 0;
  private lastIn = 0;
  private lastOut = 0;
  private buffer = new Float32Array(4096);
  private length = 0;

  setRates(cpuHz: number, sampleRate: number): void {
    this.cyclesPerSample = cpuHz / sampleRate;
  }

  add(level: number): void {
    this.sum += level;
    this.count++;
    if (++this.position >= this.cyclesPerSample) {
      this.position -= this.cyclesPerSample;
      this.emit(this.sum / this.count);
      this.sum = this.count = 0;
    }
  }

  private emit(value: number): void {
    const out = value - this.lastIn + DC_BLOCK * this.lastOut;
    this.lastIn = value;
    this.lastOut = out;
    if (this.length === this.buffer.length) {
      const bigger = new Float32Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.length++] = out * GAIN;
  }

  /** The samples made since the last call. */
  takeSamples(): Float32Array {
    const samples = this.buffer.slice(0, this.length);
    this.length = 0;
    return samples;
  }
}
