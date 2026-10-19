import { describe, expect, it } from 'vitest';
import type { Nes } from '../src/nes';
import { hasTestRom, nesWithTestRom } from './helpers/rom';

// blargg's test ROMs report through cartridge RAM: $6001-$6003 hold DE B0 61 once the
// test is running, $6000 is $80 while it runs, $81 when it wants the reset button
// pressed, and otherwise the result (0 = passed). $6004 onwards holds the text it
// printed. `npm run fetch:test-roms` downloads them.
const TESTS = [
  'instr_test-v5/all_instrs.nes',
  'instr_timing/instr_timing.nes',
  'cpu_interrupts_v2/cpu_interrupts.nes',
  'cpu_dummy_writes/cpu_dummy_writes_oam.nes',
  'cpu_dummy_writes/cpu_dummy_writes_ppumem.nes',
  'cpu_reset/ram_after_reset.nes',
  'cpu_reset/registers.nes',
  'ppu_vbl_nmi/ppu_vbl_nmi.nes',
  'ppu_open_bus/ppu_open_bus.nes',
  'ppu_read_buffer/test_ppu_read_buffer.nes',
  'oam_read/oam_read.nes',
  'apu_test/apu_test.nes',
  'apu_reset/4015_cleared.nes',
  'apu_reset/4017_timing.nes',
  'apu_reset/4017_written.nes',
  'apu_reset/irq_flag_cleared.nes',
  'apu_reset/len_ctrs_enabled.nes',
  'apu_reset/works_immediately.nes',
  'mmc3_test_2/rom_singles/1-clocking.nes',
  'mmc3_test_2/rom_singles/2-details.nes',
  'mmc3_test_2/rom_singles/3-A12_clocking.nes',
  'mmc3_test_2/rom_singles/4-scanline_timing.nes',
  'mmc3_test_2/rom_singles/5-MMC3.nes',
];

const RUNNING = 0x80;
const NEEDS_RESET = 0x81;
const MAX_SECONDS = 60;
/** The tests ask for the reset button to be held a moment; they check how long. */
const RESET_DELAY_FRAMES = 6;

const peek = (nes: Nes, addr: number) => nes.cartridge?.cpuRead(addr) ?? 0;

function report(nes: Nes): string {
  let text = '';
  for (let addr = 0x6004; addr < 0x7000; addr++) {
    const byte = peek(nes, addr);
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text.trim();
}

function started(nes: Nes): boolean {
  return peek(nes, 0x6001) === 0xde && peek(nes, 0x6002) === 0xb0 && peek(nes, 0x6003) === 0x61;
}

function run(file: string): { status: number; text: string } {
  const nes = nesWithTestRom(file);
  let resetIn = -1;
  for (let frame = 0; frame < MAX_SECONDS * 60; frame++) {
    nes.runFrame();
    if (!started(nes)) continue;
    const status = peek(nes, 0x6000);
    if (status === NEEDS_RESET) {
      if (resetIn < 0) resetIn = RESET_DELAY_FRAMES;
      else if (--resetIn === 0) {
        nes.pressReset();
        resetIn = -1;
      }
    } else if (status !== RUNNING) {
      return { status, text: report(nes) };
    }
  }
  return { status: -1, text: `still running after ${MAX_SECONDS} seconds: ${report(nes)}` };
}

describe('blargg test ROMs', () => {
  for (const file of TESTS) {
    it.skipIf(!hasTestRom(file))(file, () => {
      const { status, text } = run(file);
      expect(status, text).toBe(0);
    }, 120_000);
  }
});
