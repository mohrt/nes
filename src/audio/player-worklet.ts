// Runs on the audio rendering thread. Plays sample chunks posted by the emulator.

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** Start playing once this much audio is queued, so small hiccups don't cause gaps. */
const TARGET_LATENCY_SECONDS = 0.06;
/** If the emulator gets this far ahead of the speakers, drop audio back to the target. */
const MAX_LATENCY_SECONDS = 0.2;
/** How quickly the last sample fades to silence when the queue runs dry. */
const UNDERRUN_FADE = 0.995;

class SamplePlayer extends AudioWorkletProcessor {
  private readonly queue: Float32Array[] = [];
  private queued = 0;
  private offset = 0;
  private buffering = true;
  private last = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<Float32Array | 'flush'>) => {
      if (event.data === 'flush') {
        this.queue.length = 0;
        this.queued = this.offset = 0;
        this.buffering = true;
        return;
      }
      this.queue.push(event.data);
      this.queued += event.data.length;
      if (this.queued > MAX_LATENCY_SECONDS * sampleRate) this.drop(this.queued - TARGET_LATENCY_SECONDS * sampleRate);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const out = channels[0];
    if (this.buffering && this.queued >= TARGET_LATENCY_SECONDS * sampleRate) this.buffering = false;

    for (let i = 0; i < out.length; i++) {
      if (this.buffering || this.queue.length === 0) {
        this.buffering = true;
        this.last *= UNDERRUN_FADE;
        out[i] = this.last;
        continue;
      }
      const chunk = this.queue[0];
      out[i] = this.last = chunk[this.offset++];
      this.queued--;
      if (this.offset === chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    for (let c = 1; c < channels.length; c++) channels[c].set(out);
    return true;
  }

  private drop(samples: number): void {
    while (samples > 0 && this.queue.length > 0) {
      const available = this.queue[0].length - this.offset;
      const take = Math.min(available, samples);
      this.offset += take;
      this.queued -= take;
      samples -= take;
      if (this.offset === this.queue[0].length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
  }
}

registerProcessor('sample-player', SamplePlayer);
