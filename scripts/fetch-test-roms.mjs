// Downloads freely distributed NES test ROMs (kevtris's nestest, blargg's test suites) for the tests.
// They are not committed; the tests that need them skip when they are missing.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = 'https://raw.githubusercontent.com/christopherpow/nes-test-roms/master';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'test-roms');

const files = [
  'other/nestest.nes',
  'other/nestest.log',
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

for (const file of files) {
  const response = await fetch(`${base}/${file}`);
  if (!response.ok) {
    console.error(`Download of ${file} failed: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  const outFile = join(outDir, file);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
  console.log(`Saved ${outFile}`);
}
