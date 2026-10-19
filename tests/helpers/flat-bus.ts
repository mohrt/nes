import type { CpuBus } from '../../src/cpu/cpu2a03';

/** 64K of plain RAM that counts bus cycles, for testing the CPU in isolation. */
export class FlatBus implements CpuBus {
  readonly memory = new Uint8Array(0x10000);
  cycles = 0;
  readonly log: string[] = [];
  logging = false;

  read(addr: number): number {
    this.cycles++;
    if (this.logging) this.log.push(`R ${addr.toString(16)}`);
    return this.memory[addr];
  }

  write(addr: number, value: number): void {
    this.cycles++;
    if (this.logging) this.log.push(`W ${addr.toString(16)}`);
    this.memory[addr] = value;
  }

  load(addr: number, bytes: ArrayLike<number>): void {
    this.memory.set(bytes, addr);
  }
}
