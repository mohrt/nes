import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasTestRom, nesWithTestRom, testRomPath } from './helpers/rom';

// kevtris's nestest in "automation" mode (start at $C000): every instruction, its registers and
// cycle count must match the log from a real NES. `npm run fetch:test-roms` downloads it.
const ROM = 'other/nestest.nes';
const LOG = 'other/nestest.log';

const hex = (value: number, digits: number) => value.toString(16).toUpperCase().padStart(digits, '0');

describe.skipIf(!hasTestRom(ROM) || !hasTestRom(LOG))('nestest', () => {
  it('matches the reference log, instruction for instruction', () => {
    const lines = readFileSync(testRomPath(LOG), 'utf8').split(/\r?\n/).filter(Boolean);
    const nes = nesWithTestRom(ROM);
    const { cpu, bus } = nes;
    cpu.pc = 0xc000;
    for (const [n, line] of lines.entries()) {
      const expected = `${line.slice(0, 4)} A:${line.slice(50, 52)} X:${line.slice(55, 57)} Y:${line.slice(60, 62)} P:${line.slice(65, 67)} SP:${line.slice(71, 73)} ${line.slice(86)}`;
      const actual = `${hex(cpu.pc, 4)} A:${hex(cpu.a, 2)} X:${hex(cpu.x, 2)} Y:${hex(cpu.y, 2)} P:${hex(cpu.status, 2)} SP:${hex(cpu.sp, 2)} CYC:${bus.cycles}`;
      expect(actual, `line ${n + 1}: ${line}`).toBe(expected);
      cpu.step();
    }
    // The test leaves its result codes in $02 and $03: zero means every test passed.
    expect(bus.ram[2]).toBe(0);
    expect(bus.ram[3]).toBe(0);
  });
});
