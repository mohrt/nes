import workletUrl from './player-worklet.ts?worker&url';

/**
 * Sends emulator audio to the speakers through an AudioWorklet. Browsers only
 * allow audio to start after a user gesture, so playback begins on the first
 * click, tap or key press.
 */
export class AudioOutput {
  private enabled = true;
  private readonly gain: GainNode;

  private constructor(
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
  ) {
    this.gain = context.createGain();
    node.connect(this.gain).connect(context.destination);
  }

  static async create(): Promise<AudioOutput> {
    const context = new AudioContext({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, 'sample-player', { outputChannelCount: [2] });
    return new AudioOutput(context, node);
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  /** True once the browser has let audio start. */
  get running(): boolean {
    return this.context.state === 'running';
  }

  /** Resumes playback on the first user gesture; calls `onStart` once it is running. */
  resumeOnGesture(target: Window, onStart: () => void): void {
    const resume = () => {
      void this.context.resume().then(() => {
        if (!this.running) return;
        target.removeEventListener('pointerdown', resume);
        target.removeEventListener('keydown', resume);
        onStart();
      });
    };
    target.addEventListener('pointerdown', resume);
    target.addEventListener('keydown', resume);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.flush();
  }

  setVolume(volume: number): void {
    this.gain.gain.value = volume;
  }

  /** Queues samples for playback (ignored while muted or before audio has started). */
  play(samples: Float32Array): void {
    if (!this.enabled || !this.running || samples.length === 0) return;
    this.node.port.postMessage(samples, [samples.buffer]);
  }

  /** Drops queued audio, e.g. after pausing. */
  flush(): void {
    this.node.port.postMessage('flush');
  }
}
