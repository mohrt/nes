import { describe, expect, it } from 'vitest';
import type { Mmc3 } from '../src/cart/mappers/mmc3';
import type { Nes } from '../src/nes';
import { batteryKey } from '../src/storage/battery-saves';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from '../src/storage/save-states';
import { MemoryStore } from '../src/storage/store';
import { assemble } from './helpers/asm';
import { inesImage, nesWith } from './helpers/rom';

/** An MMC3 cartridge whose program keeps the CPU, PPU, APU and mapper all busy. */
const PROGRAM = assemble(`
reset:  sei
        ldx #$ff
        txs
        lda #$01
        sta SNDCHN
        lda #$bf
        sta $4000
        lda #$80
        sta PPUCTRL
        lda #$1e
        sta PPUMASK
loop:   inc $20
        lda $20
        sta $4002
        sta $8001          ; MMC3 bank data
        sta $6000          ; PRG RAM
        jmp loop
nmi:    inc $21
        lda #$08
        sta $4003
        rti
        .org $fffa
        .word nmi, reset, nmi
`, 0x8000, 0x8000);
const ROM = inesImage({ prg: PROGRAM, chr: new Uint8Array(0x2000).map((_, i) => i * 7), mapper: 4, battery: true });

function running(frames: number): Nes {
  const nes = nesWith(ROM);
  for (let i = 0; i < frames; i++) nes.runFrame();
  return nes;
}

/** What should match between two machines run the same way from the same state. */
function fingerprint(nes: Nes) {
  return {
    pc: nes.cpu.pc,
    cycles: nes.bus.cycles,
    ram: [...nes.bus.ram],
    frame: [...nes.ppu.framebuffer],
    dot: [nes.ppu.scanline, nes.ppu.dot],
    banks: [...(nes.cartridge as Mmc3).registers],
    prgRam: nes.cartridge!.cpuRead(0x6000),
    pulse: nes.apu.pulse1.period,
    audio: [...nes.apu.mixer.takeSamples()],
  };
}

describe('save states', () => {
  it('restores a machine so it carries on exactly as the original did', () => {
    const original = running(10);
    const state = original.saveState();
    original.apu.mixer.takeSamples();
    for (let i = 0; i < 5; i++) original.runFrame();

    const restored = running(0);
    restored.loadState(state);
    restored.apu.mixer.takeSamples();
    for (let i = 0; i < 5; i++) restored.runFrame();

    expect(fingerprint(restored)).toEqual(fingerprint(original));
  });

  it('keeps the TV system', () => {
    const nes = running(1);
    nes.setRegion('pal');
    const other = running(1);
    other.loadState(nes.saveState());
    expect(other.region).toBe('pal');
    expect(other.ppu.linesPerFrame).toBe(312);
  });

  it('round-trips a session through the file format and the store, newest first', async () => {
    const nes = running(3);
    const session: Session = { machine: nes.saveState(), rom: ROM, romName: 'test.nes', title: 'Test' };
    const decoded = await decodeSession(await encodeSession(session));
    expect(decoded.rom).toEqual(ROM);
    const copy = running(0);
    copy.loadState(decoded.machine);
    expect(copy.bus.cycles).toBe(nes.bus.cycles);

    const states = new SaveStates(new MemoryStore<SaveStateRecord>());
    await states.add('first', session);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await states.add('second', session);
    const list = await states.list();
    expect(list.map((s) => s.name)).toEqual(['second', 'first']);
    expect((await states.load(list[1].id))?.title).toBe('Test');
    await states.delete(list[0].id);
    expect((await states.list()).length).toBe(1);
  });

  it('rejects files that are not NES states', async () => {
    await expect(decodeSession(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not an NES save state/);
  });

  it('keys battery saves by the ROM, not its header', () => {
    const reheadered = ROM.slice();
    reheadered[9] = 1;
    expect(batteryKey(reheadered)).toBe(batteryKey(ROM));
    expect(batteryKey(inesImage({ prg: new Uint8Array(0x4000) }))).not.toBe(batteryKey(ROM));
  });
});
