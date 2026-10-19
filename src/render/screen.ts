import { PALETTE } from '../ppu/palette';
import { FRAME_HEIGHT, FRAME_WIDTH } from '../ppu/ppu';

/** NTSC NES pixels are a little wider than tall on a TV. */
export const PIXEL_ASPECT = 8 / 7;
/** TVs hid about 8 lines at the top and bottom; games often leave junk there. */
export const OVERSCAN_LINES = 8;

export function screenAspect(cropOverscan: boolean): number {
  return (FRAME_WIDTH * PIXEL_ASPECT) / (FRAME_HEIGHT - (cropOverscan ? 2 * OVERSCAN_LINES : 0));
}

/** Turns finished PPU frames (9-bit colours) into canvas pixels. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private image!: ImageData;
  private pixels!: Uint32Array;
  private firstLine = 0;
  private hasNewFrame = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    this.setCropOverscan(false);
  }

  setCropOverscan(crop: boolean): void {
    this.firstLine = crop ? OVERSCAN_LINES : 0;
    const height = FRAME_HEIGHT - 2 * this.firstLine;
    this.canvas.width = FRAME_WIDTH;
    this.canvas.height = height;
    this.image = this.context.createImageData(FRAME_WIDTH, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.hasNewFrame = true;
  }

  capture(frame: Uint16Array): void {
    const { pixels } = this;
    const offset = this.firstLine * FRAME_WIDTH;
    for (let i = 0; i < pixels.length; i++) pixels[i] = PALETTE[frame[offset + i]];
    this.hasNewFrame = true;
  }

  /** A dark screen with a faint scanline pattern, shown while no cartridge is in. */
  showIdle(): void {
    const { pixels } = this;
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i / FRAME_WIDTH) & 1 ? 0xff141414 : 0xff1c1c1c;
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }
}
