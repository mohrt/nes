/**
 * A tiny two-pass 6502 assembler for test ROMs. Supports labels (`name:`),
 * equates (`NAME = $12`), `.org`, `.byte`, `.word`, comments (`;`) and the
 * documented instruction set. Operands may be numbers ($hex, %binary,
 * decimal), labels, `<label`/`>label` and `+`/`-` sums.
 */

type Mode = 'imp' | 'acc' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'absx' | 'absy' | 'ind' | 'indx' | 'indy' | 'rel';

const OPS: Record<string, Partial<Record<Mode, number>>> = {
  ADC: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, absx: 0x7d, absy: 0x79, indx: 0x61, indy: 0x71 },
  AND: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, absx: 0x3d, absy: 0x39, indx: 0x21, indy: 0x31 },
  ASL: { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, absx: 0x1e },
  BCC: { rel: 0x90 }, BCS: { rel: 0xb0 }, BEQ: { rel: 0xf0 }, BMI: { rel: 0x30 },
  BNE: { rel: 0xd0 }, BPL: { rel: 0x10 }, BVC: { rel: 0x50 }, BVS: { rel: 0x70 },
  BIT: { zp: 0x24, abs: 0x2c },
  BRK: { imp: 0x00 },
  CLC: { imp: 0x18 }, CLD: { imp: 0xd8 }, CLI: { imp: 0x58 }, CLV: { imp: 0xb8 },
  CMP: { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, absx: 0xdd, absy: 0xd9, indx: 0xc1, indy: 0xd1 },
  CPX: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  CPY: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  DEC: { zp: 0xc6, zpx: 0xd6, abs: 0xce, absx: 0xde },
  DEX: { imp: 0xca }, DEY: { imp: 0x88 },
  EOR: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, absx: 0x5d, absy: 0x59, indx: 0x41, indy: 0x51 },
  INC: { zp: 0xe6, zpx: 0xf6, abs: 0xee, absx: 0xfe },
  INX: { imp: 0xe8 }, INY: { imp: 0xc8 },
  JMP: { abs: 0x4c, ind: 0x6c },
  JSR: { abs: 0x20 },
  LDA: { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, absx: 0xbd, absy: 0xb9, indx: 0xa1, indy: 0xb1 },
  LDX: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, absy: 0xbe },
  LDY: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, absx: 0xbc },
  LSR: { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, absx: 0x5e },
  NOP: { imp: 0xea },
  ORA: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, absx: 0x1d, absy: 0x19, indx: 0x01, indy: 0x11 },
  PHA: { imp: 0x48 }, PHP: { imp: 0x08 }, PLA: { imp: 0x68 }, PLP: { imp: 0x28 },
  ROL: { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, absx: 0x3e },
  ROR: { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, absx: 0x7e },
  RTI: { imp: 0x40 }, RTS: { imp: 0x60 },
  SBC: { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, absx: 0xfd, absy: 0xf9, indx: 0xe1, indy: 0xf1 },
  SEC: { imp: 0x38 }, SED: { imp: 0xf8 }, SEI: { imp: 0x78 },
  STA: { zp: 0x85, zpx: 0x95, abs: 0x8d, absx: 0x9d, absy: 0x99, indx: 0x81, indy: 0x91 },
  STX: { zp: 0x86, zpy: 0x96, abs: 0x8e },
  STY: { zp: 0x84, zpx: 0x94, abs: 0x8c },
  TAX: { imp: 0xaa }, TAY: { imp: 0xa8 }, TSX: { imp: 0xba }, TXA: { imp: 0x8a },
  TXS: { imp: 0x9a }, TYA: { imp: 0x98 },
};

const SIZE: Record<Mode, number> = {
  imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, absx: 3, absy: 3, ind: 3, indx: 2, indy: 2, rel: 2,
};

/** Standard NES register names, predefined for every program. */
export const HARDWARE_SYMBOLS: Record<string, number> = {
  PPUCTRL: 0x2000, PPUMASK: 0x2001, PPUSTATUS: 0x2002, OAMADDR: 0x2003, OAMDATA: 0x2004,
  PPUSCROLL: 0x2005, PPUADDR: 0x2006, PPUDATA: 0x2007, OAMDMA: 0x4014, SNDCHN: 0x4015,
  JOY1: 0x4016, JOY2: 0x4017,
};

function parseNumber(token: string): number | null {
  if (/^\$[0-9a-f]+$/i.test(token)) return parseInt(token.slice(1), 16);
  if (/^%[01]+$/.test(token)) return parseInt(token.slice(1), 2);
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return null;
}

/** Evaluates an operand expression; returns null if it uses a label not yet defined. */
function evaluate(expr: string, symbols: Map<string, number>): number | null {
  expr = expr.trim();
  if (expr.startsWith('<') || expr.startsWith('>')) {
    const value = evaluate(expr.slice(1), symbols);
    if (value === null) return null;
    return expr[0] === '<' ? value & 0xff : (value >> 8) & 0xff;
  }
  let total = 0;
  for (const match of expr.matchAll(/([+-]?)\s*([^+\-\s]+)/g)) {
    const [, sign, term] = match;
    const value = parseNumber(term) ?? symbols.get(term.toUpperCase()) ?? null;
    if (value === null) return null;
    total += sign === '-' ? -value : value;
  }
  return total;
}

function parseOperand(operand: string): { mode: Mode; expr: string } {
  if (operand === '') return { mode: 'imp', expr: '' };
  if (operand.toUpperCase() === 'A') return { mode: 'acc', expr: '' };
  if (operand.startsWith('#')) return { mode: 'imm', expr: operand.slice(1) };
  let match = /^\((.+),\s*X\)$/i.exec(operand);
  if (match) return { mode: 'indx', expr: match[1] };
  match = /^\((.+)\),\s*Y$/i.exec(operand);
  if (match) return { mode: 'indy', expr: match[1] };
  match = /^\((.+)\)$/.exec(operand);
  if (match) return { mode: 'ind', expr: match[1] };
  match = /^(.+),\s*([XY])$/i.exec(operand);
  if (match) return { mode: match[2].toUpperCase() === 'X' ? 'absx' : 'absy', expr: match[1] };
  return { mode: 'abs', expr: operand };
}

/** Assembles `source` into a ROM image of `size` bytes mapped at `base` (default: 16K of PRG at $C000). */
export function assemble(source: string, size = 0x4000, base = 0xc000): Uint8Array {
  const symbols = new Map(Object.entries(HARDWARE_SYMBOLS));
  const lines = source.split('\n').map((line) => line.replace(/;.*$/, '').trim());
  let rom = new Uint8Array(size);

  for (const pass of [1, 2]) {
    rom = new Uint8Array(size);
    let pc = base;
    const emit = (byte: number) => {
      if (pass === 2) {
        const offset = pc - base;
        if (offset < 0 || offset >= size) throw new Error(`Address $${pc.toString(16)} is outside the ROM`);
        rom[offset] = byte & 0xff;
      }
      pc++;
    };
    const value = (expr: string): number => {
      const result = evaluate(expr, symbols);
      if (result === null && pass === 2) throw new Error(`Unknown value: ${expr}`);
      return result ?? 0xffff;
    };

    for (let line of lines) {
      const label = /^([A-Za-z_]\w*):/.exec(line);
      if (label) {
        if (label[1].toUpperCase() in HARDWARE_SYMBOLS) throw new Error(`Label ${label[1]} hides a register name`);
        symbols.set(label[1].toUpperCase(), pc);
        line = line.slice(label[0].length).trim();
      }
      if (!line) continue;
      const equate = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(line);
      if (equate) {
        symbols.set(equate[1].toUpperCase(), value(equate[2]));
        continue;
      }
      const [word, ...rest] = line.split(/\s+/);
      const operand = rest.join(' ').trim();
      const directive = word.toLowerCase();
      if (directive === '.org') {
        pc = value(operand);
        continue;
      }
      if (directive === '.byte') {
        for (const item of operand.split(',')) emit(value(item));
        continue;
      }
      if (directive === '.word') {
        for (const item of operand.split(',')) {
          const word16 = value(item);
          emit(word16);
          emit(word16 >> 8);
        }
        continue;
      }

      const mnemonic = word.toUpperCase();
      const modes = OPS[mnemonic];
      if (!modes) throw new Error(`Unknown instruction: ${line}`);
      let { mode, expr } = parseOperand(operand);
      if (modes.rel !== undefined) mode = 'rel';
      if (mode === 'imp' && modes.imp === undefined && modes.acc !== undefined) mode = 'acc';
      const known = expr ? evaluate(expr, symbols) : null;
      // Zero-page forms when the address is known to fit (and the instruction has one).
      if (known !== null && known < 0x100) {
        if (mode === 'abs' && modes.zp !== undefined) mode = 'zp';
        else if (mode === 'absx' && modes.zpx !== undefined) mode = 'zpx';
        else if (mode === 'absy' && modes.zpy !== undefined) mode = 'zpy';
      }
      const opcode = modes[mode];
      if (opcode === undefined) throw new Error(`Bad addressing mode: ${line}`);
      emit(opcode);
      if (mode === 'rel') {
        const target = value(expr);
        const offset = pass === 2 ? target - (pc + 1) : 0;
        if (pass === 2 && (offset < -128 || offset > 127)) throw new Error(`Branch out of range: ${line}`);
        emit(offset);
      } else if (SIZE[mode] === 2) {
        emit(value(expr));
      } else if (SIZE[mode] === 3) {
        const address = value(expr);
        emit(address);
        emit(address >> 8);
      }
    }
  }
  return rom;
}
