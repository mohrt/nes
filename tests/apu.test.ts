import { describe, expect, it } from 'vitest';
import { Apu } from '../src/apu/apu';
import { CPU_HZ } from '../src/nes';

const SAMPLE_RATE = 48000;

function apu(): Apu {
  const unit = new Apu();
  unit.powerOn();
  unit.mixer.setRates(CPU_HZ.ntsc, SAMPLE_RATE);
  return unit;
}

const run = (unit: Apu, cycles: number) => {
  for (let i = 0; i < cycles; i++) unit.tick();
};

/** Upward zero crossings per second in the mixer's output. */
function frequency(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  return crossings / (samples.length / SAMPLE_RATE);
}

describe('APU', () => {
  it('reports length counters in $4015, and clears them when a channel is disabled', () => {
    const unit = apu();
    unit.writeRegister(0x4015, 0x0f);
    unit.writeRegister(0x4003, 0x08); // pulse 1, length index 1 (254)
    unit.writeRegister(0x400f, 0x08);
    expect(unit.readStatus() & 0x0f).toBe(0x09);
    unit.writeRegister(0x4015, 0x08);
    expect(unit.readStatus() & 0x0f).toBe(0x08);
  });

  it('counts lengths down on half frames until the channel goes quiet', () => {
    const unit = apu();
    unit.writeRegister(0x4015, 0x01);
    unit.writeRegister(0x4000, 0x00); // length counter running
    unit.writeRegister(0x4003, 0x18); // length index 3 = 2 half frames
    run(unit, 14915);
    expect(unit.pulse1.length).toBe(1);
    run(unit, 14915);
    expect(unit.readStatus() & 0x01).toBe(0);
  });

  it('raises the frame IRQ every 29830 cycles in 4-step mode, unless inhibited', () => {
    const unit = apu();
    run(unit, 29826);
    expect(unit.irq).toBe(false);
    run(unit, 5);
    expect(unit.irq).toBe(true);
    expect(unit.readStatus() & 0x40).toBe(0x40);
    expect(unit.irq).toBe(false);
    unit.writeRegister(0x4017, 0x40);
    run(unit, 30000);
    expect(unit.irq).toBe(false);
  });

  it('plays a pulse wave at the frequency its period gives', () => {
    const unit = apu();
    unit.writeRegister(0x4015, 0x01);
    unit.writeRegister(0x4000, 0xbf); // 50% duty, constant volume 15
    unit.writeRegister(0x4002, 0xfd); // period 253: 1789773 / (16 * 254) = 440 Hz
    unit.writeRegister(0x4003, 0x00);
    unit.mixer.takeSamples();
    run(unit, CPU_HZ.ntsc / 2);
    expect(frequency(unit.mixer.takeSamples())).toBeCloseTo(440, -1);
  });

  it('silences a pulse whose sweep would overflow, and steps the triangle only with both counters running', () => {
    const unit = apu();
    unit.writeRegister(0x4015, 0x05);
    unit.writeRegister(0x4000, 0xbf);
    unit.writeRegister(0x4002, 0xff);
    unit.writeRegister(0x4003, 0x07); // period $7FF: the sweep target is beyond $7FF
    run(unit, 100);
    expect(unit.pulse1.output).toBe(0);
    unit.writeRegister(0x4008, 0x00); // linear counter 0
    unit.writeRegister(0x400a, 0x10);
    unit.writeRegister(0x400b, 0x08);
    const step = unit.triangle.step;
    run(unit, 20000);
    expect(unit.triangle.step).toBe(step);
  });

  it('reads DMC samples by DMA and raises its IRQ at the end of a sample', () => {
    const unit = apu();
    unit.writeRegister(0x4010, 0x8f); // IRQ on, fastest rate
    unit.writeRegister(0x4013, 0x00); // 1 byte
    unit.writeRegister(0x4015, 0x10);
    expect(unit.dmc.needsByte).toBe(true);
    expect(unit.dmc.address).toBe(0xc000);
    unit.dmc.receive(0xff);
    expect(unit.dmc.needsByte).toBe(false);
    expect(unit.irq).toBe(true);
    expect(unit.readStatus() & 0x80).toBe(0x80);
  });
});
