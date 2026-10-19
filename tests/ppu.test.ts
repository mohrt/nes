import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { parseInes } from '../src/cart/ines';
import { Ppu } from '../src/ppu/ppu';
import { assemble } from './helpers/asm';
import { inesImage, nesWith } from './helpers/rom';

/** A PPU with a plain cartridge (8K of CHR RAM, horizontal mirroring). */
function ppuWithCart(): Ppu {
  const ppu = new Ppu();
  const cart = new Cartridge(parseInes(inesImage({ prg: new Uint8Array(0x4000) })));
  cart.reset();
  ppu.cartridge = cart;
  ppu.powerOn();
  return ppu;
}

function setAddress(ppu: Ppu, addr: number): void {
  ppu.writeRegister(6, addr >> 8);
  ppu.writeRegister(6, addr & 0xff);
}

describe('PPU registers', () => {
  it('buffers $2007 reads, except from the palette', () => {
    const ppu = ppuWithCart();
    setAddress(ppu, 0x2000);
    ppu.writeRegister(7, 0x11);
    ppu.writeRegister(7, 0x22);
    setAddress(ppu, 0x2000);
    ppu.readRegister(7); // stale buffer
    expect(ppu.readRegister(7)).toBe(0x11);
    expect(ppu.readRegister(7)).toBe(0x22);
    setAddress(ppu, 0x3f01);
    ppu.writeRegister(7, 0x2c);
    setAddress(ppu, 0x3f01);
    expect(ppu.readRegister(7) & 0x3f).toBe(0x2c);
  });

  it('steps the address by 32 when PPUCTRL asks', () => {
    const ppu = ppuWithCart();
    ppu.writeRegister(0, 0x04);
    setAddress(ppu, 0x2000);
    ppu.writeRegister(7, 1);
    expect(ppu.v).toBe(0x2020);
  });

  it('mirrors the backdrop entries of the sprite palettes', () => {
    const ppu = ppuWithCart();
    setAddress(ppu, 0x3f10);
    ppu.writeRegister(7, 0x15);
    expect(ppu.paletteRam[0]).toBe(0x15);
  });

  it('mirrors the nametables as the cartridge is wired', () => {
    const ppu = ppuWithCart(); // horizontal: $2000 = $2400
    setAddress(ppu, 0x2005);
    ppu.writeRegister(7, 0x77);
    setAddress(ppu, 0x2405);
    ppu.readRegister(7);
    expect(ppu.readRegister(7)).toBe(0x77);
  });

  it('loads the scroll registers into t and fine X, and clears the toggle on a $2002 read', () => {
    const ppu = ppuWithCart();
    ppu.writeRegister(5, 0x7d); // coarse X 15, fine X 5
    ppu.writeRegister(5, 0x5e); // coarse Y 11, fine Y 6
    expect(ppu.fineX).toBe(5);
    expect(ppu.t).toBe((6 << 12) | (11 << 5) | 15);
    ppu.writeRegister(5, 0);
    ppu.readRegister(2);
    expect(ppu.w).toBe(false);
  });
});

/**
 * A program that draws tile 1 (solid colour 1) at the top left of the
 * screen over a backdrop, puts sprite 0 (the same tile) over it, and counts
 * NMIs in $10.
 */
const DRAWING = assemble(`
reset:  sei
        ldx #$ff
        txs
        bit PPUSTATUS
wait1:  bit PPUSTATUS
        bpl wait1
wait2:  bit PPUSTATUS
        bpl wait2
        lda #$3f            ; palette: backdrop $21, colour 1 = $16, sprite colour 1 = $2a
        sta PPUADDR
        lda #$00
        sta PPUADDR
        lda #$21
        sta PPUDATA
        lda #$16
        sta PPUDATA
        lda #$3f
        sta PPUADDR
        lda #$11
        sta PPUADDR
        lda #$2a
        sta PPUDATA
        lda #$00            ; tile 1's low plane: all set
        sta PPUADDR
        lda #$10
        sta PPUADDR
        ldx #8
        lda #$ff
tile:   sta PPUDATA
        dex
        bne tile
        lda #$20            ; nametable: tile 1 at the top left
        sta PPUADDR
        lda #$00
        sta PPUADDR
        lda #1
        sta PPUDATA
        lda #0              ; sprite 0: tile 1 at (0, 1)
        sta OAMADDR
        sta OAMDATA
        lda #1
        sta OAMDATA
        lda #0
        sta OAMDATA
        sta OAMDATA
        lda #$f0            ; the other sprites off screen
        ldx #252
hide:   sta OAMDATA
        dex
        bne hide
        lda #0
        sta PPUSCROLL
        sta PPUSCROLL
        lda #$80            ; NMI on
        sta PPUCTRL
        lda #$1e            ; background and sprites, left column too
        sta PPUMASK
loop:   jmp loop
nmi:    inc $10
irq:    rti
        .org $fffa
        .word nmi, reset, irq
`);

describe('PPU rendering', () => {
  const run = () => {
    const nes = nesWith(inesImage({ prg: DRAWING }));
    for (let i = 0; i < 6; i++) nes.runFrame();
    return nes;
  };

  it('draws the background tile over the backdrop colour', () => {
    const { ppu } = run();
    expect(ppu.framebuffer[0]).toBe(0x16);
    expect(ppu.framebuffer[8]).toBe(0x21);
    expect(ppu.framebuffer[9 * 256]).toBe(0x21);
  });

  it('draws sprites one line below their Y, in front of the background', () => {
    const { ppu } = run();
    expect(ppu.framebuffer[0]).toBe(0x16); // line 0: no sprite
    expect(ppu.framebuffer[256 + 3]).toBe(0x2a);
    expect(ppu.framebuffer[256 * 8]).toBe(0x2a); // line 8: the sprite's last line
    expect(ppu.framebuffer[256 * 9]).toBe(0x21);
  });

  it('sets the sprite 0 hit flag where sprite 0 meets the background', () => {
    const { ppu } = run();
    expect(ppu.status & 0x40).toBe(0x40);
  });

  it('raises an NMI every frame once enabled', () => {
    const nes = run();
    const before = nes.bus.ram[0x10];
    for (let i = 0; i < 5; i++) nes.runFrame();
    expect(nes.bus.ram[0x10] - before).toBe(5);
  });

  it('applies greyscale and colour emphasis to the output', () => {
    const nes = run();
    nes.ppu.mask = 0x1e | 0x01 | 0x20;
    nes.runFrame();
    expect(nes.ppu.framebuffer[0]).toBe((0x16 & 0x30) | (1 << 6));
  });

  it('runs 262 lines a frame on NTSC (odd frames a dot short) and 312 on PAL', () => {
    const nes = run();
    // Frames end at an instruction boundary, a few dots late; over many frames that evens out.
    const FRAMES = 200;
    const dotsPerFrame = () => {
      const start = nes.ppu.dots;
      for (let i = 0; i < FRAMES; i++) nes.runFrame();
      return (nes.ppu.dots - start) / FRAMES;
    };
    expect(dotsPerFrame()).toBeCloseTo(341 * 262 - 0.5, 0);
    nes.setRegion('pal');
    nes.runFrame();
    expect(dotsPerFrame()).toBeCloseTo(341 * 312, 0);
  });
});
