import type { Cartridge } from '../cart/cartridge';

export const FRAME_WIDTH = 256;
export const FRAME_HEIGHT = 240;
const DOTS_PER_LINE = 341;
const VBLANK_LINE = 241;

const STATUS_OVERFLOW = 0x20;
const STATUS_SPRITE0 = 0x40;
const STATUS_VBLANK = 0x80;

const CTRL_INCREMENT_32 = 0x04;
const CTRL_SPRITE_TABLE = 0x08;
const CTRL_BG_TABLE = 0x10;
const CTRL_TALL_SPRITES = 0x20;
const CTRL_NMI = 0x80;

const MASK_GREYSCALE = 0x01;
const MASK_BG_LEFT = 0x02;
const MASK_SPRITES_LEFT = 0x04;
const MASK_BG = 0x08;
const MASK_SPRITES = 0x10;
const MASK_RENDERING = MASK_BG | MASK_SPRITES;

// Sprite line buffer entries: bits 0-3 the palette entry (above $10), then these flags. 0 is transparent.
const SPRITE_BEHIND = 0x10;
const SPRITE_ZERO = 0x20;
const MAX_SPRITES = 8;
/** Bits of the PPU's data latch fade to 0 about this long after they were last driven (around 600 ms). */
const OPEN_BUS_DECAY_FRAMES = 36;

/** Bits of a pattern byte in reverse order, for horizontally flipped sprites. */
const REVERSED = Uint8Array.from({ length: 256 }, (_, n) => {
  let r = 0;
  for (let bit = 0; bit < 8; bit++) if (n & (1 << bit)) r |= 0x80 >> bit;
  return r;
});

/**
 * The 2C02 picture processor, run one dot at a time: 341 dots a line, 262
 * lines a frame (312 on PAL). The background is fetched and shifted out as on
 * the chip, so mid-frame changes to scrolling or banks land where they should,
 * and the cartridge sees every address the PPU fetches.
 *
 * Pixels are written as 9-bit colours: the 6-bit palette value plus the three
 * colour emphasis bits.
 */
export class Ppu {
  ctrl = 0;
  mask = 0;
  status = 0;
  oamAddr = 0;
  readonly oam = new Uint8Array(256);
  /** Nametable RAM: the console's 2K, plus room for a four-screen cartridge's extra 2K. */
  readonly ciram = new Uint8Array(0x1000);
  readonly paletteRam = new Uint8Array(32);

  /** Current VRAM address, temporary address, fine X scroll and the $2005/$2006 write toggle ("loopy" registers). */
  v = 0;
  t = 0;
  fineX = 0;
  w = false;
  readBuffer = 0;
  /** The last value on the PPU's data bus, returned by reads of write-only registers. */
  openBus = 0;
  /** The frame each bit of the data latch was last driven in. */
  readonly openBusFrames = new Float64Array(8);

  scanline = 0;
  dot = 0;
  oddFrame = false;
  private skipLastDot = false;
  /** Total dots run, which mappers use to time the address lines. */
  dots = 0;
  frames = 0;
  linesPerFrame = 262;
  /** PAL swaps the red and green emphasis bits, and has no short frames. */
  pal = false;
  /** Set when a $2002 read lands just before vertical blank starts: that frame's flag (and NMI) is skipped. */
  suppressVblank = false;
  /** Set when a frame's picture is complete; the machine clears it. */
  frameReady = false;

  // Background pipeline
  private ntByte = 0;
  private atBits = 0;
  private patternLo = 0;
  private patternHi = 0;
  private bgLo = 0;
  private bgHi = 0;
  private attrLo = 0;
  private attrHi = 0;

  // Sprites found for the next line, then their patterns
  private spriteCount = 0;
  private spriteZeroFound = false;
  private readonly spriteIndex = new Uint8Array(MAX_SPRITES);
  private readonly spriteRow = new Uint8Array(MAX_SPRITES);
  private readonly spriteLo = new Uint8Array(MAX_SPRITES);
  private readonly spriteHi = new Uint8Array(MAX_SPRITES);
  /** The sprite pixels of the line being drawn. */
  readonly spriteLine = new Uint8Array(FRAME_WIDTH);

  readonly framebuffer = new Uint16Array(FRAME_WIDTH * FRAME_HEIGHT);
  cartridge: Cartridge | null = null;

  /** The /NMI output: vertical blank with NMIs enabled. */
  get nmiOutput(): boolean {
    return (this.status & STATUS_VBLANK) !== 0 && (this.ctrl & CTRL_NMI) !== 0;
  }

  get renderingEnabled(): boolean {
    return (this.mask & MASK_RENDERING) !== 0;
  }

  private get preRenderLine(): number {
    return this.linesPerFrame - 1;
  }

  reset(): void {
    this.ctrl = this.mask = this.status = this.oamAddr = 0;
    this.v = this.t = this.fineX = 0;
    this.w = false;
    this.readBuffer = this.openBus = 0;
    this.scanline = this.dot = 0;
    this.oddFrame = false;
    this.suppressVblank = this.frameReady = false;
    this.spriteCount = 0;
    this.spriteLine.fill(0);
  }

  /** Switching on also clears the memories (real RAM powers up with junk; zeros are kinder). */
  powerOn(): void {
    this.reset();
    this.oam.fill(0);
    this.ciram.fill(0);
    this.paletteRam.fill(0);
    this.framebuffer.fill(0);
  }

  // --- CPU interface ($2000-$2007) ---------------------------------------------------

  readRegister(reg: number): number {
    switch (reg & 7) {
      case 2: {
        const value = this.status & 0xe0;
        this.status &= ~STATUS_VBLANK;
        this.w = false;
        if (this.scanline === VBLANK_LINE && this.dot === 1) this.suppressVblank = true;
        return this.driveBus(value, 0xe0);
      }
      case 4: {
        let value = this.oam[this.oamAddr];
        if ((this.oamAddr & 3) === 2) value &= 0xe3;
        return this.driveBus(value, 0xff);
      }
      case 7: {
        const addr = this.v & 0x3fff;
        let result: number;
        if (addr >= 0x3f00) {
          // Palette reads are immediate (6 bits); the buffer gets the nametable byte "underneath".
          const value = this.paletteRam[paletteIndex(addr)] & (this.mask & MASK_GREYSCALE ? 0x30 : 0x3f);
          this.readBuffer = this.readVram(addr - 0x1000);
          result = this.driveBus(value, 0x3f);
        } else {
          result = this.driveBus(this.readBuffer, 0xff);
          this.readBuffer = this.readVram(addr);
        }
        this.stepAddress();
        return result;
      }
      default:
        return this.driveBus(0, 0);
    }
  }

  /**
   * The PPU's data latch: a read drives the bits in `driven` and returns the
   * others as they were last driven, unless they have faded away by now.
   */
  private driveBus(value: number, driven: number): number {
    for (let bit = 0; bit < 8; bit++) {
      const mask = 1 << bit;
      if (driven & mask) this.openBusFrames[bit] = this.frames;
      else if (this.frames - this.openBusFrames[bit] > OPEN_BUS_DECAY_FRAMES) this.openBus &= ~mask;
    }
    this.openBus = (this.openBus & ~driven) | (value & driven);
    return this.openBus;
  }

  writeRegister(reg: number, value: number): void {
    this.driveBus(value, 0xff);
    switch (reg & 7) {
      case 0:
        this.ctrl = value;
        this.t = (this.t & 0xf3ff) | ((value & 0x03) << 10);
        break;
      case 1:
        this.mask = value;
        break;
      case 3:
        this.oamAddr = value;
        break;
      case 4:
        if (this.renderingEnabled && (this.scanline < FRAME_HEIGHT || this.scanline === this.preRenderLine)) {
          // Writes during rendering don't land; they only bump the address.
          this.oamAddr = (this.oamAddr + 4) & 0xff;
        } else {
          this.oam[this.oamAddr] = value;
          this.oamAddr = (this.oamAddr + 1) & 0xff;
        }
        break;
      case 5:
        if (!this.w) {
          this.t = (this.t & 0xffe0) | (value >> 3);
          this.fineX = value & 7;
        } else {
          this.t = (this.t & 0x8c1f) | ((value & 0x07) << 12) | ((value & 0xf8) << 2);
        }
        this.w = !this.w;
        break;
      case 6:
        if (!this.w) {
          this.t = (this.t & 0x00ff) | ((value & 0x3f) << 8);
        } else {
          this.t = (this.t & 0xff00) | value;
          this.v = this.t;
          this.noteAddress(this.v);
        }
        this.w = !this.w;
        break;
      case 7:
        this.writeVram(this.v & 0x3fff, value);
        this.stepAddress();
        break;
    }
  }

  /** OAM DMA writes go through $2004. */
  writeOam(value: number): void {
    this.writeRegister(4, value);
  }

  /** After a $2007 access: the address steps by 1 or 32, or, during rendering, both scroll counters glitch forward. */
  private stepAddress(): void {
    if (this.renderingEnabled && (this.scanline < FRAME_HEIGHT || this.scanline === this.preRenderLine)) {
      this.incrementX();
      this.incrementY();
    } else {
      this.v = (this.v + (this.ctrl & CTRL_INCREMENT_32 ? 32 : 1)) & 0x7fff;
    }
    this.noteAddress(this.v);
  }

  private noteAddress(addr: number): void {
    const cart = this.cartridge;
    if (cart?.watchesPpu) cart.ppuAddress(addr & 0x3fff, this.dots);
  }

  // --- PPU memory ----------------------------------------------------------------------

  private readVram(addr: number): number {
    const cart = this.cartridge;
    if (addr < 0x2000) {
      if (!cart) return 0;
      const value = cart.ppuRead(addr);
      if (cart.watchesPpu) cart.ppuAddress(addr, this.dots);
      return value;
    }
    if (addr < 0x3f00 || !cart) {
      if (cart?.watchesPpu) cart.ppuAddress(addr, this.dots);
      return this.ciram[(cart ? cart.nametables[(addr >> 10) & 3] : (addr >> 1) & 0x400) + (addr & 0x3ff)];
    }
    return this.paletteRam[paletteIndex(addr)];
  }

  private writeVram(addr: number, value: number): void {
    const cart = this.cartridge;
    if (addr < 0x2000) {
      cart?.ppuWrite(addr, value);
    } else if (addr < 0x3f00) {
      this.ciram[(cart ? cart.nametables[(addr >> 10) & 3] : 0) + (addr & 0x3ff)] = value;
    } else {
      this.paletteRam[paletteIndex(addr)] = value & 0x3f;
    }
  }

  // --- Rendering ---------------------------------------------------------------------

  /** Runs one dot. */
  tick(): void {
    const line = this.scanline;
    const dot = this.dot;
    const preRender = line === this.preRenderLine;

    if (line < FRAME_HEIGHT || preRender) {
      if (this.mask & MASK_RENDERING) this.renderDot(line, dot, preRender);
      else if (!preRender && dot >= 1 && dot <= FRAME_WIDTH) this.backdropPixel(dot - 1, line);
      if (preRender && dot === 1) {
        this.status &= ~(STATUS_VBLANK | STATUS_SPRITE0 | STATUS_OVERFLOW);
      }
    } else if (line === VBLANK_LINE && dot === 1) {
      if (!this.suppressVblank) this.status |= STATUS_VBLANK;
      this.suppressVblank = false;
      this.frameReady = true;
      this.frames++;
    }

    this.dots++;
    if (preRender && dot === 338) this.skipLastDot = this.oddFrame && !this.pal && (this.mask & MASK_RENDERING) !== 0;
    if (preRender && dot === 339 && this.skipLastDot) {
      // Odd frames skip the last dot of the pre-render line (if rendering was on a moment before).
      this.dot = 0;
      this.scanline = 0;
      this.oddFrame = false;
      return;
    }
    if (++this.dot === DOTS_PER_LINE) {
      this.dot = 0;
      if (++this.scanline === this.linesPerFrame) {
        this.scanline = 0;
        this.oddFrame = !this.oddFrame;
      }
    }
  }

  private renderDot(line: number, dot: number, preRender: boolean): void {
    if ((dot >= 1 && dot <= 256) || (dot >= 321 && dot <= 336)) {
      if (dot <= 256 && !preRender) this.renderPixel(dot - 1, line);
      this.bgLo = (this.bgLo << 1) & 0xffff;
      this.bgHi = (this.bgHi << 1) & 0xffff;
      this.attrLo = (this.attrLo << 1) & 0xffff;
      this.attrHi = (this.attrHi << 1) & 0xffff;
      switch (dot & 7) {
        case 1:
          this.ntByte = this.readVram(0x2000 | (this.v & 0x0fff));
          break;
        case 3: {
          const v = this.v;
          const at = this.readVram(0x23c0 | (v & 0x0c00) | ((v >> 4) & 0x38) | ((v >> 2) & 0x07));
          this.atBits = (at >> (((v >> 4) & 4) | (v & 2))) & 3;
          break;
        }
        case 5:
          this.patternLo = this.readVram(((this.ctrl & CTRL_BG_TABLE) << 8) + this.ntByte * 16 + ((this.v >> 12) & 7));
          break;
        case 7:
          this.patternHi = this.readVram(((this.ctrl & CTRL_BG_TABLE) << 8) + this.ntByte * 16 + ((this.v >> 12) & 7) + 8);
          break;
        case 0:
          this.bgLo |= this.patternLo;
          this.bgHi |= this.patternHi;
          this.attrLo |= this.atBits & 1 ? 0xff : 0;
          this.attrHi |= this.atBits & 2 ? 0xff : 0;
          this.incrementX();
          if (dot === 256) this.incrementY();
          break;
      }
      return;
    }
    if (dot === 257) {
      this.v = (this.v & ~0x041f) | (this.t & 0x041f);
      this.oamAddr = 0;
      if (preRender) this.spriteCount = 0;
      else this.evaluateSprites(line);
      return;
    }
    if (dot > 257 && dot <= 320) {
      if (preRender && dot >= 280 && dot <= 304) this.v = (this.v & ~0x7be0) | (this.t & 0x7be0);
      // Each sprite slot's pattern is fetched over 8 dots; do it on the slot's pattern-fetch dot.
      if ((dot & 7) === 5) this.fetchSprite((dot - 261) >> 3);
      if (dot === 320) this.buildSpriteLine(preRender);
      return;
    }
    if (dot === 337 || dot === 339) this.readVram(0x2000 | (this.v & 0x0fff));
  }

  private renderPixel(x: number, line: number): void {
    const mask = this.mask;
    let color = 0;
    if (mask & MASK_BG && (x >= 8 || mask & MASK_BG_LEFT)) {
      const shift = 15 - this.fineX;
      const pixel = (((this.bgHi >> shift) & 1) << 1) | ((this.bgLo >> shift) & 1);
      if (pixel) color = (((this.attrHi >> shift) & 1) << 3) | (((this.attrLo >> shift) & 1) << 2) | pixel;
    }
    const sprite = this.spriteLine[x];
    if (sprite && mask & MASK_SPRITES && (x >= 8 || mask & MASK_SPRITES_LEFT)) {
      if (color && sprite & SPRITE_ZERO && x !== 255) this.status |= STATUS_SPRITE0;
      if (!color || !(sprite & SPRITE_BEHIND)) color = 0x10 | (sprite & 0x0f);
    }
    this.output(x, line, this.paletteRam[color]);
  }

  /** With rendering off the screen shows the backdrop colour, or the palette entry the VRAM address points at. */
  private backdropPixel(x: number, line: number): void {
    const v = this.v & 0x3fff;
    this.output(x, line, this.paletteRam[v >= 0x3f00 ? paletteIndex(v) : 0]);
  }

  private output(x: number, line: number, paletteValue: number): void {
    const mask = this.mask;
    let emphasis = mask >> 5;
    if (this.pal) emphasis = (emphasis & 4) | ((emphasis & 1) << 1) | ((emphasis & 2) >> 1);
    this.framebuffer[line * FRAME_WIDTH + x] = (paletteValue & (mask & MASK_GREYSCALE ? 0x30 : 0x3f)) | (emphasis << 6);
  }

  private incrementX(): void {
    if ((this.v & 0x001f) === 31) this.v = (this.v & ~0x001f) ^ 0x0400;
    else this.v++;
  }

  private incrementY(): void {
    let v = this.v;
    if ((v & 0x7000) !== 0x7000) {
      v += 0x1000;
    } else {
      v &= ~0x7000;
      let y = (v & 0x03e0) >> 5;
      if (y === 29) {
        y = 0;
        v ^= 0x0800;
      } else if (y === 31) {
        y = 0;
      } else {
        y++;
      }
      v = (v & ~0x03e0) | (y << 5);
    }
    this.v = v;
  }

  /** Finds the first eight sprites on the next line, and sets the overflow flag the buggy way the chip does. */
  private evaluateSprites(line: number): void {
    const height = this.ctrl & CTRL_TALL_SPRITES ? 16 : 8;
    const oam = this.oam;
    let count = 0;
    let n = 0;
    this.spriteZeroFound = false;
    for (; n < 64 && count < MAX_SPRITES; n++) {
      const row = line - oam[n * 4];
      if (row >= 0 && row < height) {
        if (n === 0) this.spriteZeroFound = true;
        this.spriteIndex[count] = n;
        this.spriteRow[count] = row;
        count++;
      }
    }
    // After eight, the chip also steps through the bytes within each entry as it goes ("diagonal" reads).
    let m = 0;
    while (n < 64) {
      const row = line - oam[n * 4 + m];
      if (row >= 0 && row < height) {
        this.status |= STATUS_OVERFLOW;
        break;
      }
      n++;
      m = (m + 1) & 3;
    }
    this.spriteCount = count;
  }

  /** Fetches the pattern row of sprite slot `slot` (empty slots fetch tile $FF, as the chip does). */
  private fetchSprite(slot: number): void {
    const tall = (this.ctrl & CTRL_TALL_SPRITES) !== 0;
    let tile = 0xff;
    let row = 0;
    let attributes = 0;
    if (slot < this.spriteCount) {
      const base = this.spriteIndex[slot] * 4;
      tile = this.oam[base + 1];
      attributes = this.oam[base + 2];
      row = this.spriteRow[slot];
      if (attributes & 0x80) row = (tall ? 15 : 7) - row;
    }
    let addr: number;
    if (tall) {
      addr = ((tile & 1) << 12) | ((tile & 0xfe) << 4);
      if (row >= 8) addr += 16;
      addr += row & 7;
    } else {
      addr = ((this.ctrl & CTRL_SPRITE_TABLE) << 9) | (tile << 4) | row;
    }
    let lo = this.readVram(addr);
    let hi = this.readVram(addr + 8);
    if (slot >= this.spriteCount) return;
    if (attributes & 0x40) {
      lo = REVERSED[lo];
      hi = REVERSED[hi];
    }
    this.spriteLo[slot] = lo;
    this.spriteHi[slot] = hi;
  }

  /** Draws the fetched sprites into the next line's buffer; lower OAM entries win where they overlap. */
  private buildSpriteLine(preRender: boolean): void {
    const out = this.spriteLine;
    out.fill(0);
    if (preRender) return;
    for (let slot = this.spriteCount - 1; slot >= 0; slot--) {
      const base = this.spriteIndex[slot] * 4;
      const attributes = this.oam[base + 2];
      const x0 = this.oam[base + 3];
      const lo = this.spriteLo[slot];
      const hi = this.spriteHi[slot];
      const flags =
        ((attributes & 3) << 2) | (attributes & 0x20 ? SPRITE_BEHIND : 0) | (slot === 0 && this.spriteZeroFound ? SPRITE_ZERO : 0);
      for (let px = 0; px < 8; px++) {
        const x = x0 + px;
        if (x >= FRAME_WIDTH) break;
        const pixel = (((hi >> (7 - px)) & 1) << 1) | ((lo >> (7 - px)) & 1);
        if (pixel) out[x] = flags | pixel;
      }
    }
  }
}

/** $3F10/$3F14/$3F18/$3F1C are mirrors of $3F00/$3F04/$3F08/$3F0C. */
function paletteIndex(addr: number): number {
  const index = addr & 0x1f;
  return (index & 0x13) === 0x10 ? index & 0x0f : index;
}
