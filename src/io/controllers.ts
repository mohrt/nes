/** Controller buttons, as the bits in the order the controller reports them (A first). */
export const Button = {
  A: 0x01,
  B: 0x02,
  Select: 0x04,
  Start: 0x08,
  Up: 0x10,
  Down: 0x20,
  Left: 0x40,
  Right: 0x80,
} as const;

export interface PadState {
  /** Held buttons (Button bits). */
  buttons: number;
  /** Buttons pressed and released automatically while held (turbo A and B). */
  turbo: number;
}

const idle = (): PadState => ({ buttons: 0, turbo: 0 });

/** One controller, pressed by several input sources (keyboard, gamepad, on-screen pad) at once. */
export class ControllerInput {
  private readonly sources = new Map<string, PadState>();

  set(source: string, state: Partial<PadState>): void {
    this.sources.set(source, { ...idle(), ...state });
  }

  clear(source: string): void {
    this.sources.delete(source);
  }

  get state(): PadState {
    const merged = idle();
    for (const state of this.sources.values()) {
      merged.buttons |= state.buttons;
      merged.turbo |= state.turbo;
    }
    return merged;
  }
}

/** A D-pad can't press opposite directions together; games such as Zelda misbehave if they see it. */
function withoutOpposites(buttons: number): number {
  if ((buttons & (Button.Up | Button.Down)) === (Button.Up | Button.Down)) buttons &= ~(Button.Up | Button.Down);
  if ((buttons & (Button.Left | Button.Right)) === (Button.Left | Button.Right)) buttons &= ~(Button.Left | Button.Right);
  return buttons;
}

/**
 * The two standard controller ports. Writing 1 then 0 to $4016 latches the
 * buttons into each controller's shift register; each read of $4016/$4017
 * then gives the next button, A first. After eight reads they read 1.
 */
export class Controllers {
  strobe = false;
  readonly shift = [0, 0];
  /** Whether turbo buttons are currently "down"; the machine flips this every few frames. */
  turboOn = false;
  readonly inputs: readonly [ControllerInput, ControllerInput] = [new ControllerInput(), new ControllerInput()];

  reset(): void {
    this.strobe = false;
    this.shift[0] = this.shift[1] = 0;
  }

  write(value: number): void {
    this.strobe = (value & 1) !== 0;
    if (this.strobe) this.latch();
  }

  private latch(): void {
    for (let port = 0; port < 2; port++) {
      const state = this.inputs[port].state;
      this.shift[port] = withoutOpposites(state.buttons | (this.turboOn ? state.turbo : 0));
    }
  }

  read(port: 0 | 1): number {
    if (this.strobe) this.latch();
    const bit = this.shift[port] & 1;
    this.shift[port] = (this.shift[port] >> 1) | 0x80;
    return bit;
  }
}
