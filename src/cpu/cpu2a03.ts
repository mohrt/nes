/**
 * The CPU's view of the system. Every call is exactly one CPU cycle: the
 * machine advances the PPU and APU on each access, so the core performs the
 * same dummy reads and writes as the real chip, cycle for cycle.
 */
export interface CpuBus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

const FLAG_C = 0x01;
const FLAG_Z = 0x02;
const FLAG_I = 0x04;
const FLAG_D = 0x08;
const FLAG_B = 0x10;
const FLAG_U = 0x20;
const FLAG_V = 0x40;
const FLAG_N = 0x80;

const VECTOR_NMI = 0xfffa;
const VECTOR_RESET = 0xfffc;
const VECTOR_IRQ = 0xfffe;

/** ANE ANDs with an unstable "magic" constant; $EE matches most chips. */
const ANE_MAGIC = 0xee;
/** On the 2A03, LXA behaves as if its constant were $FF (what NES tests expect). */
const LXA_MAGIC = 0xff;

/**
 * The 2A03's NMOS 6502 core: all 256 opcodes, including the undocumented
 * ones, but with decimal mode disconnected (the D flag is kept, and ignored).
 *
 * Interrupts are sampled at the end of every cycle, and an instruction is
 * followed by an interrupt if one was pending at the end of its second-to-last
 * cycle, as on the real chip. NMI is edge-triggered, IRQ level-triggered.
 */
export class Cpu2A03 {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xfd;
  pc = 0;

  flagC = false;
  flagZ = false;
  flagI = true;
  flagD = false;
  flagV = false;
  flagN = false;

  /** The NMI input (the PPU's /NMI output, active high here). Set by the machine every cycle. */
  nmiLine = false;
  /** The IRQ input: true while any source (APU, DMC, mapper) holds it. Set by the machine every cycle. */
  irqLine = false;
  private prevNmiLine = false;
  private needNmi = false;
  private prevNeedNmi = false;
  private runIrq = false;
  private prevRunIrq = false;

  /** Address of the JAM opcode that halted the CPU, or -1 while running. Only reset recovers. */
  jammedAt = -1;

  constructor(private readonly bus: CpuBus) {}

  /** Switching on: registers cleared, then the reset sequence. */
  powerOn(): void {
    this.a = this.x = this.y = 0;
    this.sp = 0;
    this.status = FLAG_I;
    this.nmiLine = this.irqLine = false;
    this.reset();
  }

  /** The 7-cycle reset sequence: three suppressed pushes, then the reset vector. */
  reset(): void {
    this.jammedAt = -1;
    this.flagI = true;
    this.prevNmiLine = this.needNmi = this.prevNeedNmi = this.runIrq = this.prevRunIrq = false;
    this.read(this.pc);
    this.read(this.pc);
    for (let i = 0; i < 3; i++) {
      this.read(0x100 | this.sp);
      this.sp = (this.sp - 1) & 0xff;
    }
    this.pc = this.read(VECTOR_RESET) | (this.read(VECTOR_RESET + 1) << 8);
  }

  get status(): number {
    return (
      (this.flagC ? FLAG_C : 0) |
      (this.flagZ ? FLAG_Z : 0) |
      (this.flagI ? FLAG_I : 0) |
      (this.flagD ? FLAG_D : 0) |
      FLAG_U |
      (this.flagV ? FLAG_V : 0) |
      (this.flagN ? FLAG_N : 0)
    );
  }

  set status(p: number) {
    this.flagC = (p & FLAG_C) !== 0;
    this.flagZ = (p & FLAG_Z) !== 0;
    this.flagI = (p & FLAG_I) !== 0;
    this.flagD = (p & FLAG_D) !== 0;
    this.flagV = (p & FLAG_V) !== 0;
    this.flagN = (p & FLAG_N) !== 0;
  }

  /** Executes one instruction, or the interrupt sequence if one is due. A jammed CPU just keeps the bus busy. */
  step(): void {
    if (this.jammedAt >= 0) {
      this.read(0xffff);
      return;
    }
    if (this.prevNeedNmi || this.prevRunIrq) {
      this.interrupt();
      return;
    }
    const opcode = this.fetch();
    if (!this.execute(opcode)) {
      this.pc = (this.pc - 1) & 0xffff;
      this.jammedAt = this.pc;
    }
  }

  // --- Bus helpers ------------------------------------------------------------

  read(addr: number): number {
    const value = this.bus.read(addr);
    this.pollInterrupts();
    return value;
  }

  write(addr: number, value: number): void {
    this.bus.write(addr, value);
    this.pollInterrupts();
  }

  /** End of a cycle: latch an NMI edge, and whether an IRQ would be taken. */
  private pollInterrupts(): void {
    this.prevNeedNmi = this.needNmi;
    if (this.nmiLine && !this.prevNmiLine) this.needNmi = true;
    this.prevNmiLine = this.nmiLine;
    this.prevRunIrq = this.runIrq;
    this.runIrq = this.irqLine && !this.flagI;
  }

  /** Pushes PC and P and jumps through a vector; an NMI arriving in time takes over an IRQ or BRK. */
  private enterInterrupt(breakFlag: number): void {
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    const vector = this.needNmi ? VECTOR_NMI : VECTOR_IRQ;
    if (this.needNmi) this.needNmi = false;
    this.push(this.status | breakFlag);
    this.flagI = true;
    const lo = this.read(vector);
    this.pc = lo | (this.read(vector + 1) << 8);
    // The handler's first instruction always runs before an NMI that arrived during the sequence.
    this.prevNeedNmi = false;
  }

  private interrupt(): void {
    this.read(this.pc);
    this.read(this.pc);
    this.enterInterrupt(0);
  }

  private fetch(): number {
    const value = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  /** The second cycle of one-byte instructions reads the next byte and throws it away. */
  private idle(): void {
    this.read(this.pc);
  }

  private push(value: number): void {
    this.write(0x100 | this.sp, value);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pull(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(0x100 | this.sp);
  }

  // --- Addressing modes (return the effective address after their bus cycles) --

  private zp(): number {
    return this.fetch();
  }

  private zpIndexed(index: number): number {
    const base = this.fetch();
    this.read(base);
    return (base + index) & 0xff;
  }

  private abs(): number {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }

  /** Indexed absolute: reads the un-carried address first when the page is crossed (always for stores). */
  private absIndexed(index: number, alwaysDummy: boolean): number {
    const lo = this.fetch();
    const hi = this.fetch() << 8;
    const sum = lo + index;
    if (alwaysDummy || sum > 0xff) this.read(hi | (sum & 0xff));
    return (hi + sum) & 0xffff;
  }

  private indX(): number {
    const base = this.fetch();
    this.read(base);
    const ptr = (base + this.x) & 0xff;
    const lo = this.read(ptr);
    return lo | (this.read((ptr + 1) & 0xff) << 8);
  }

  private indirectBase(): number {
    const ptr = this.fetch();
    const lo = this.read(ptr);
    return lo | (this.read((ptr + 1) & 0xff) << 8);
  }

  private indY(alwaysDummy: boolean): number {
    const base = this.indirectBase();
    const sum = (base & 0xff) + this.y;
    if (alwaysDummy || sum > 0xff) this.read((base & 0xff00) | (sum & 0xff));
    return (base + this.y) & 0xffff;
  }

  // --- Operations ---------------------------------------------------------------

  private setNZ(value: number): number {
    this.flagZ = value === 0;
    this.flagN = (value & 0x80) !== 0;
    return value;
  }

  private adc(value: number): void {
    const result = this.a + value + (this.flagC ? 1 : 0);
    this.flagV = (~(this.a ^ value) & (this.a ^ result) & 0x80) !== 0;
    this.flagC = result > 0xff;
    this.a = this.setNZ(result & 0xff);
  }

  private sbc(value: number): void {
    this.adc(value ^ 0xff);
  }

  private compare(register: number, value: number): void {
    const result = register - value;
    this.flagC = result >= 0;
    this.setNZ(result & 0xff);
  }

  private bit(value: number): void {
    this.flagZ = (this.a & value) === 0;
    this.flagN = (value & 0x80) !== 0;
    this.flagV = (value & 0x40) !== 0;
  }

  private asl(value: number): number {
    this.flagC = (value & 0x80) !== 0;
    return this.setNZ((value << 1) & 0xff);
  }

  private lsr(value: number): number {
    this.flagC = (value & 0x01) !== 0;
    return this.setNZ(value >> 1);
  }

  private rol(value: number): number {
    const result = ((value << 1) | (this.flagC ? 1 : 0)) & 0xff;
    this.flagC = (value & 0x80) !== 0;
    return this.setNZ(result);
  }

  private ror(value: number): number {
    const result = (value >> 1) | (this.flagC ? 0x80 : 0);
    this.flagC = (value & 0x01) !== 0;
    return this.setNZ(result);
  }

  /** Read-modify-write: the 6502 writes the unmodified value back before the result. */
  private rmw(addr: number, op: (value: number) => number): void {
    const value = this.read(addr);
    this.write(addr, value);
    this.write(addr, op(value));
  }

  private branch(condition: boolean): void {
    const offset = this.fetch();
    if (!condition) return;
    // A taken branch that stays in its page doesn't poll interrupts on its last cycle.
    if (this.runIrq && !this.prevRunIrq) this.runIrq = false;
    this.read(this.pc);
    const target = (this.pc + (offset < 0x80 ? offset : offset - 0x100)) & 0xffff;
    if ((target ^ this.pc) & 0xff00) this.read((this.pc & 0xff00) | (target & 0xff));
    this.pc = target;
  }

  private readonly aslOp = (v: number) => this.asl(v);
  private readonly lsrOp = (v: number) => this.lsr(v);
  private readonly rolOp = (v: number) => this.rol(v);
  private readonly rorOp = (v: number) => this.ror(v);
  private readonly incOp = (v: number) => this.setNZ((v + 1) & 0xff);
  private readonly decOp = (v: number) => this.setNZ((v - 1) & 0xff);

  // Undocumented read-modify-write combinations: shift/increment memory, then use the result.
  private readonly sloOp = (v: number) => {
    const r = this.asl(v);
    this.a = this.setNZ(this.a | r);
    return r;
  };
  private readonly rlaOp = (v: number) => {
    const r = this.rol(v);
    this.a = this.setNZ(this.a & r);
    return r;
  };
  private readonly sreOp = (v: number) => {
    const r = this.lsr(v);
    this.a = this.setNZ(this.a ^ r);
    return r;
  };
  private readonly rraOp = (v: number) => {
    const r = this.ror(v);
    this.adc(r);
    return r;
  };
  private readonly dcpOp = (v: number) => {
    const r = (v - 1) & 0xff;
    this.compare(this.a, r);
    return r;
  };
  private readonly iscOp = (v: number) => {
    const r = (v + 1) & 0xff;
    this.sbc(r);
    return r;
  };

  private lax(value: number): void {
    this.a = this.x = this.setNZ(value);
  }

  private arr(value: number): void {
    const t = this.a & value;
    const carryIn = this.flagC ? 0x80 : 0;
    const result = (t >> 1) | carryIn;
    this.a = this.setNZ(result);
    this.flagC = (result & 0x40) !== 0;
    this.flagV = (((result >> 6) ^ (result >> 5)) & 1) !== 0;
  }

  /**
   * SHA/SHX/SHY/TAS store `value & (high byte of base + 1)`. When indexing
   * crosses a page, that same value also replaces the target's high byte.
   */
  private storeAndHigh(base: number, index: number, value: number): void {
    const sum = (base & 0xff) + index;
    this.read((base & 0xff00) | (sum & 0xff));
    const stored = value & (((base >> 8) + 1) & 0xff);
    let addr = (base + index) & 0xffff;
    if (sum > 0xff) addr = (addr & 0x00ff) | (stored << 8);
    this.write(addr, stored);
  }

  /** Returns false for the JAM opcodes, which halt the CPU. */
  private execute(opcode: number): boolean {
    const bus = this;
    switch (opcode) {
      // ORA
      case 0x09: this.a = this.setNZ(this.a | this.fetch()); break;
      case 0x05: this.a = this.setNZ(this.a | bus.read(this.zp())); break;
      case 0x15: this.a = this.setNZ(this.a | bus.read(this.zpIndexed(this.x))); break;
      case 0x0d: this.a = this.setNZ(this.a | bus.read(this.abs())); break;
      case 0x1d: this.a = this.setNZ(this.a | bus.read(this.absIndexed(this.x, false))); break;
      case 0x19: this.a = this.setNZ(this.a | bus.read(this.absIndexed(this.y, false))); break;
      case 0x01: this.a = this.setNZ(this.a | bus.read(this.indX())); break;
      case 0x11: this.a = this.setNZ(this.a | bus.read(this.indY(false))); break;

      // AND
      case 0x29: this.a = this.setNZ(this.a & this.fetch()); break;
      case 0x25: this.a = this.setNZ(this.a & bus.read(this.zp())); break;
      case 0x35: this.a = this.setNZ(this.a & bus.read(this.zpIndexed(this.x))); break;
      case 0x2d: this.a = this.setNZ(this.a & bus.read(this.abs())); break;
      case 0x3d: this.a = this.setNZ(this.a & bus.read(this.absIndexed(this.x, false))); break;
      case 0x39: this.a = this.setNZ(this.a & bus.read(this.absIndexed(this.y, false))); break;
      case 0x21: this.a = this.setNZ(this.a & bus.read(this.indX())); break;
      case 0x31: this.a = this.setNZ(this.a & bus.read(this.indY(false))); break;

      // EOR
      case 0x49: this.a = this.setNZ(this.a ^ this.fetch()); break;
      case 0x45: this.a = this.setNZ(this.a ^ bus.read(this.zp())); break;
      case 0x55: this.a = this.setNZ(this.a ^ bus.read(this.zpIndexed(this.x))); break;
      case 0x4d: this.a = this.setNZ(this.a ^ bus.read(this.abs())); break;
      case 0x5d: this.a = this.setNZ(this.a ^ bus.read(this.absIndexed(this.x, false))); break;
      case 0x59: this.a = this.setNZ(this.a ^ bus.read(this.absIndexed(this.y, false))); break;
      case 0x41: this.a = this.setNZ(this.a ^ bus.read(this.indX())); break;
      case 0x51: this.a = this.setNZ(this.a ^ bus.read(this.indY(false))); break;

      // ADC
      case 0x69: this.adc(this.fetch()); break;
      case 0x65: this.adc(bus.read(this.zp())); break;
      case 0x75: this.adc(bus.read(this.zpIndexed(this.x))); break;
      case 0x6d: this.adc(bus.read(this.abs())); break;
      case 0x7d: this.adc(bus.read(this.absIndexed(this.x, false))); break;
      case 0x79: this.adc(bus.read(this.absIndexed(this.y, false))); break;
      case 0x61: this.adc(bus.read(this.indX())); break;
      case 0x71: this.adc(bus.read(this.indY(false))); break;

      // SBC
      case 0xe9: case 0xeb: this.sbc(this.fetch()); break;
      case 0xe5: this.sbc(bus.read(this.zp())); break;
      case 0xf5: this.sbc(bus.read(this.zpIndexed(this.x))); break;
      case 0xed: this.sbc(bus.read(this.abs())); break;
      case 0xfd: this.sbc(bus.read(this.absIndexed(this.x, false))); break;
      case 0xf9: this.sbc(bus.read(this.absIndexed(this.y, false))); break;
      case 0xe1: this.sbc(bus.read(this.indX())); break;
      case 0xf1: this.sbc(bus.read(this.indY(false))); break;

      // CMP / CPX / CPY
      case 0xc9: this.compare(this.a, this.fetch()); break;
      case 0xc5: this.compare(this.a, bus.read(this.zp())); break;
      case 0xd5: this.compare(this.a, bus.read(this.zpIndexed(this.x))); break;
      case 0xcd: this.compare(this.a, bus.read(this.abs())); break;
      case 0xdd: this.compare(this.a, bus.read(this.absIndexed(this.x, false))); break;
      case 0xd9: this.compare(this.a, bus.read(this.absIndexed(this.y, false))); break;
      case 0xc1: this.compare(this.a, bus.read(this.indX())); break;
      case 0xd1: this.compare(this.a, bus.read(this.indY(false))); break;
      case 0xe0: this.compare(this.x, this.fetch()); break;
      case 0xe4: this.compare(this.x, bus.read(this.zp())); break;
      case 0xec: this.compare(this.x, bus.read(this.abs())); break;
      case 0xc0: this.compare(this.y, this.fetch()); break;
      case 0xc4: this.compare(this.y, bus.read(this.zp())); break;
      case 0xcc: this.compare(this.y, bus.read(this.abs())); break;

      // BIT
      case 0x24: this.bit(bus.read(this.zp())); break;
      case 0x2c: this.bit(bus.read(this.abs())); break;

      // LDA / LDX / LDY
      case 0xa9: this.a = this.setNZ(this.fetch()); break;
      case 0xa5: this.a = this.setNZ(bus.read(this.zp())); break;
      case 0xb5: this.a = this.setNZ(bus.read(this.zpIndexed(this.x))); break;
      case 0xad: this.a = this.setNZ(bus.read(this.abs())); break;
      case 0xbd: this.a = this.setNZ(bus.read(this.absIndexed(this.x, false))); break;
      case 0xb9: this.a = this.setNZ(bus.read(this.absIndexed(this.y, false))); break;
      case 0xa1: this.a = this.setNZ(bus.read(this.indX())); break;
      case 0xb1: this.a = this.setNZ(bus.read(this.indY(false))); break;
      case 0xa2: this.x = this.setNZ(this.fetch()); break;
      case 0xa6: this.x = this.setNZ(bus.read(this.zp())); break;
      case 0xb6: this.x = this.setNZ(bus.read(this.zpIndexed(this.y))); break;
      case 0xae: this.x = this.setNZ(bus.read(this.abs())); break;
      case 0xbe: this.x = this.setNZ(bus.read(this.absIndexed(this.y, false))); break;
      case 0xa0: this.y = this.setNZ(this.fetch()); break;
      case 0xa4: this.y = this.setNZ(bus.read(this.zp())); break;
      case 0xb4: this.y = this.setNZ(bus.read(this.zpIndexed(this.x))); break;
      case 0xac: this.y = this.setNZ(bus.read(this.abs())); break;
      case 0xbc: this.y = this.setNZ(bus.read(this.absIndexed(this.x, false))); break;

      // STA / STX / STY
      case 0x85: bus.write(this.zp(), this.a); break;
      case 0x95: bus.write(this.zpIndexed(this.x), this.a); break;
      case 0x8d: bus.write(this.abs(), this.a); break;
      case 0x9d: bus.write(this.absIndexed(this.x, true), this.a); break;
      case 0x99: bus.write(this.absIndexed(this.y, true), this.a); break;
      case 0x81: bus.write(this.indX(), this.a); break;
      case 0x91: bus.write(this.indY(true), this.a); break;
      case 0x86: bus.write(this.zp(), this.x); break;
      case 0x96: bus.write(this.zpIndexed(this.y), this.x); break;
      case 0x8e: bus.write(this.abs(), this.x); break;
      case 0x84: bus.write(this.zp(), this.y); break;
      case 0x94: bus.write(this.zpIndexed(this.x), this.y); break;
      case 0x8c: bus.write(this.abs(), this.y); break;

      // Shifts and rotates
      case 0x0a: this.idle(); this.a = this.asl(this.a); break;
      case 0x06: this.rmw(this.zp(), this.aslOp); break;
      case 0x16: this.rmw(this.zpIndexed(this.x), this.aslOp); break;
      case 0x0e: this.rmw(this.abs(), this.aslOp); break;
      case 0x1e: this.rmw(this.absIndexed(this.x, true), this.aslOp); break;
      case 0x4a: this.idle(); this.a = this.lsr(this.a); break;
      case 0x46: this.rmw(this.zp(), this.lsrOp); break;
      case 0x56: this.rmw(this.zpIndexed(this.x), this.lsrOp); break;
      case 0x4e: this.rmw(this.abs(), this.lsrOp); break;
      case 0x5e: this.rmw(this.absIndexed(this.x, true), this.lsrOp); break;
      case 0x2a: this.idle(); this.a = this.rol(this.a); break;
      case 0x26: this.rmw(this.zp(), this.rolOp); break;
      case 0x36: this.rmw(this.zpIndexed(this.x), this.rolOp); break;
      case 0x2e: this.rmw(this.abs(), this.rolOp); break;
      case 0x3e: this.rmw(this.absIndexed(this.x, true), this.rolOp); break;
      case 0x6a: this.idle(); this.a = this.ror(this.a); break;
      case 0x66: this.rmw(this.zp(), this.rorOp); break;
      case 0x76: this.rmw(this.zpIndexed(this.x), this.rorOp); break;
      case 0x6e: this.rmw(this.abs(), this.rorOp); break;
      case 0x7e: this.rmw(this.absIndexed(this.x, true), this.rorOp); break;

      // INC / DEC memory
      case 0xe6: this.rmw(this.zp(), this.incOp); break;
      case 0xf6: this.rmw(this.zpIndexed(this.x), this.incOp); break;
      case 0xee: this.rmw(this.abs(), this.incOp); break;
      case 0xfe: this.rmw(this.absIndexed(this.x, true), this.incOp); break;
      case 0xc6: this.rmw(this.zp(), this.decOp); break;
      case 0xd6: this.rmw(this.zpIndexed(this.x), this.decOp); break;
      case 0xce: this.rmw(this.abs(), this.decOp); break;
      case 0xde: this.rmw(this.absIndexed(this.x, true), this.decOp); break;

      // Register increments, decrements and transfers
      case 0xe8: this.idle(); this.x = this.setNZ((this.x + 1) & 0xff); break;
      case 0xca: this.idle(); this.x = this.setNZ((this.x - 1) & 0xff); break;
      case 0xc8: this.idle(); this.y = this.setNZ((this.y + 1) & 0xff); break;
      case 0x88: this.idle(); this.y = this.setNZ((this.y - 1) & 0xff); break;
      case 0xaa: this.idle(); this.x = this.setNZ(this.a); break;
      case 0x8a: this.idle(); this.a = this.setNZ(this.x); break;
      case 0xa8: this.idle(); this.y = this.setNZ(this.a); break;
      case 0x98: this.idle(); this.a = this.setNZ(this.y); break;
      case 0xba: this.idle(); this.x = this.setNZ(this.sp); break;
      case 0x9a: this.idle(); this.sp = this.x; break;

      // Stack
      case 0x48: this.idle(); this.push(this.a); break;
      case 0x08: this.idle(); this.push(this.status | FLAG_B); break;
      case 0x68:
        this.idle();
        bus.read(0x100 | this.sp);
        this.a = this.setNZ(this.pull());
        break;
      case 0x28:
        this.idle();
        bus.read(0x100 | this.sp);
        this.status = this.pull();
        break;

      // Flags
      case 0x18: this.idle(); this.flagC = false; break;
      case 0x38: this.idle(); this.flagC = true; break;
      case 0x58: this.idle(); this.flagI = false; break;
      case 0x78: this.idle(); this.flagI = true; break;
      case 0xb8: this.idle(); this.flagV = false; break;
      case 0xd8: this.idle(); this.flagD = false; break;
      case 0xf8: this.idle(); this.flagD = true; break;

      // Branches
      case 0x10: this.branch(!this.flagN); break;
      case 0x30: this.branch(this.flagN); break;
      case 0x50: this.branch(!this.flagV); break;
      case 0x70: this.branch(this.flagV); break;
      case 0x90: this.branch(!this.flagC); break;
      case 0xb0: this.branch(this.flagC); break;
      case 0xd0: this.branch(!this.flagZ); break;
      case 0xf0: this.branch(this.flagZ); break;

      // Jumps, subroutines, interrupts
      case 0x4c: this.pc = this.abs(); break;
      case 0x6c: {
        const ptr = this.abs();
        // NMOS bug: the high byte is read without carrying into the page.
        const lo = bus.read(ptr);
        this.pc = lo | (bus.read((ptr & 0xff00) | ((ptr + 1) & 0xff)) << 8);
        break;
      }
      case 0x20: {
        const lo = this.fetch();
        bus.read(0x100 | this.sp);
        this.push(this.pc >> 8);
        this.push(this.pc & 0xff);
        this.pc = lo | (bus.read(this.pc) << 8);
        break;
      }
      case 0x60: {
        this.idle();
        bus.read(0x100 | this.sp);
        const lo = this.pull();
        this.pc = lo | (this.pull() << 8);
        this.fetch();
        break;
      }
      case 0x40: {
        this.idle();
        bus.read(0x100 | this.sp);
        this.status = this.pull();
        const lo = this.pull();
        this.pc = lo | (this.pull() << 8);
        break;
      }
      case 0x00:
        this.fetch();
        this.enterInterrupt(FLAG_B);
        // I was only just set, so no IRQ can follow straight away.
        this.prevRunIrq = false;
        break;

      case 0xea: this.idle(); break;

      // --- Undocumented opcodes ---------------------------------------------

      // NOPs of various lengths (they still perform their operand reads)
      case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: this.idle(); break;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: this.fetch(); break;
      case 0x04: case 0x44: case 0x64: bus.read(this.zp()); break;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4: bus.read(this.zpIndexed(this.x)); break;
      case 0x0c: bus.read(this.abs()); break;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc: bus.read(this.absIndexed(this.x, false)); break;

      // SLO: ASL memory, then ORA
      case 0x07: this.rmw(this.zp(), this.sloOp); break;
      case 0x17: this.rmw(this.zpIndexed(this.x), this.sloOp); break;
      case 0x0f: this.rmw(this.abs(), this.sloOp); break;
      case 0x1f: this.rmw(this.absIndexed(this.x, true), this.sloOp); break;
      case 0x1b: this.rmw(this.absIndexed(this.y, true), this.sloOp); break;
      case 0x03: this.rmw(this.indX(), this.sloOp); break;
      case 0x13: this.rmw(this.indY(true), this.sloOp); break;

      // RLA: ROL memory, then AND
      case 0x27: this.rmw(this.zp(), this.rlaOp); break;
      case 0x37: this.rmw(this.zpIndexed(this.x), this.rlaOp); break;
      case 0x2f: this.rmw(this.abs(), this.rlaOp); break;
      case 0x3f: this.rmw(this.absIndexed(this.x, true), this.rlaOp); break;
      case 0x3b: this.rmw(this.absIndexed(this.y, true), this.rlaOp); break;
      case 0x23: this.rmw(this.indX(), this.rlaOp); break;
      case 0x33: this.rmw(this.indY(true), this.rlaOp); break;

      // SRE: LSR memory, then EOR
      case 0x47: this.rmw(this.zp(), this.sreOp); break;
      case 0x57: this.rmw(this.zpIndexed(this.x), this.sreOp); break;
      case 0x4f: this.rmw(this.abs(), this.sreOp); break;
      case 0x5f: this.rmw(this.absIndexed(this.x, true), this.sreOp); break;
      case 0x5b: this.rmw(this.absIndexed(this.y, true), this.sreOp); break;
      case 0x43: this.rmw(this.indX(), this.sreOp); break;
      case 0x53: this.rmw(this.indY(true), this.sreOp); break;

      // RRA: ROR memory, then ADC
      case 0x67: this.rmw(this.zp(), this.rraOp); break;
      case 0x77: this.rmw(this.zpIndexed(this.x), this.rraOp); break;
      case 0x6f: this.rmw(this.abs(), this.rraOp); break;
      case 0x7f: this.rmw(this.absIndexed(this.x, true), this.rraOp); break;
      case 0x7b: this.rmw(this.absIndexed(this.y, true), this.rraOp); break;
      case 0x63: this.rmw(this.indX(), this.rraOp); break;
      case 0x73: this.rmw(this.indY(true), this.rraOp); break;

      // SAX: store A & X
      case 0x87: bus.write(this.zp(), this.a & this.x); break;
      case 0x97: bus.write(this.zpIndexed(this.y), this.a & this.x); break;
      case 0x8f: bus.write(this.abs(), this.a & this.x); break;
      case 0x83: bus.write(this.indX(), this.a & this.x); break;

      // LAX: load A and X
      case 0xa7: this.lax(bus.read(this.zp())); break;
      case 0xb7: this.lax(bus.read(this.zpIndexed(this.y))); break;
      case 0xaf: this.lax(bus.read(this.abs())); break;
      case 0xbf: this.lax(bus.read(this.absIndexed(this.y, false))); break;
      case 0xa3: this.lax(bus.read(this.indX())); break;
      case 0xb3: this.lax(bus.read(this.indY(false))); break;

      // DCP: DEC memory, then CMP
      case 0xc7: this.rmw(this.zp(), this.dcpOp); break;
      case 0xd7: this.rmw(this.zpIndexed(this.x), this.dcpOp); break;
      case 0xcf: this.rmw(this.abs(), this.dcpOp); break;
      case 0xdf: this.rmw(this.absIndexed(this.x, true), this.dcpOp); break;
      case 0xdb: this.rmw(this.absIndexed(this.y, true), this.dcpOp); break;
      case 0xc3: this.rmw(this.indX(), this.dcpOp); break;
      case 0xd3: this.rmw(this.indY(true), this.dcpOp); break;

      // ISC: INC memory, then SBC
      case 0xe7: this.rmw(this.zp(), this.iscOp); break;
      case 0xf7: this.rmw(this.zpIndexed(this.x), this.iscOp); break;
      case 0xef: this.rmw(this.abs(), this.iscOp); break;
      case 0xff: this.rmw(this.absIndexed(this.x, true), this.iscOp); break;
      case 0xfb: this.rmw(this.absIndexed(this.y, true), this.iscOp); break;
      case 0xe3: this.rmw(this.indX(), this.iscOp); break;
      case 0xf3: this.rmw(this.indY(true), this.iscOp); break;

      // Immediate-mode combinations
      case 0x0b: case 0x2b: // ANC
        this.a = this.setNZ(this.a & this.fetch());
        this.flagC = this.flagN;
        break;
      case 0x4b: this.a = this.lsr(this.a & this.fetch()); break; // ALR
      case 0x6b: this.arr(this.fetch()); break;
      case 0xcb: { // SBX: X = (A & X) - immediate, flags as CMP
        const result = (this.a & this.x) - this.fetch();
        this.flagC = result >= 0;
        this.x = this.setNZ(result & 0xff);
        break;
      }
      case 0x8b: this.a = this.setNZ((this.a | ANE_MAGIC) & this.x & this.fetch()); break; // ANE
      case 0xab: this.lax((this.a | LXA_MAGIC) & this.fetch()); break; // LXA

      case 0xbb: { // LAS
        const value = bus.read(this.absIndexed(this.y, false)) & this.sp;
        this.a = this.x = this.sp = this.setNZ(value);
        break;
      }

      // Stores that AND with the high address byte + 1
      case 0x9f: this.storeAndHigh(this.abs(), this.y, this.a & this.x); break; // SHA abs,Y
      case 0x93: this.storeAndHigh(this.indirectBase(), this.y, this.a & this.x); break; // SHA (zp),Y
      case 0x9e: this.storeAndHigh(this.abs(), this.y, this.x); break; // SHX
      case 0x9c: this.storeAndHigh(this.abs(), this.x, this.y); break; // SHY
      case 0x9b: // TAS
        this.sp = this.a & this.x;
        this.storeAndHigh(this.abs(), this.y, this.sp);
        break;

      // JAM: 0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2
      default:
        return false;
    }
    return true;
  }
}
