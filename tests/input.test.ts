import { describe, expect, it } from 'vitest';
import { Button, Controllers } from '../src/io/controllers';
import { GamepadManager, hatDirections, readGamepad, type GamepadLike } from '../src/io/gamepad-input';

function pad(overrides: Partial<GamepadLike> & { pressed?: number[] }): GamepadLike {
  const pressed = new Set(overrides.pressed ?? []);
  return {
    id: 'Test pad',
    index: 0,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.has(i) })),
    ...overrides,
  };
}

/** Strobes the port and reads eight buttons, A first. */
function readButtons(controllers: Controllers, port: 0 | 1 = 0): number {
  controllers.write(1);
  controllers.write(0);
  let buttons = 0;
  for (let bit = 0; bit < 8; bit++) buttons |= controllers.read(port) << bit;
  return buttons;
}

describe('controllers', () => {
  it('shifts the buttons out A, B, Select, Start, Up, Down, Left, Right, then reads 1', () => {
    const controllers = new Controllers();
    controllers.inputs[0].set('keyboard', { buttons: Button.A | Button.Start | Button.Left });
    expect(readButtons(controllers)).toBe(Button.A | Button.Start | Button.Left);
    expect(controllers.read(0)).toBe(1);
    expect(readButtons(controllers, 1)).toBe(0);
  });

  it('keeps returning A while the strobe is held', () => {
    const controllers = new Controllers();
    controllers.inputs[0].set('keyboard', { buttons: Button.A });
    controllers.write(1);
    expect([controllers.read(0), controllers.read(0)]).toEqual([1, 1]);
  });

  it('merges sources, and never presses opposite directions together', () => {
    const controllers = new Controllers();
    const input = controllers.inputs[0];
    input.set('keyboard', { buttons: Button.Left | Button.Up });
    input.set('gamepad', { buttons: Button.Right | Button.B });
    expect(readButtons(controllers)).toBe(Button.Up | Button.B);
    input.clear('gamepad');
    expect(readButtons(controllers)).toBe(Button.Left | Button.Up);
  });

  it('presses turbo buttons only while turbo is on', () => {
    const controllers = new Controllers();
    controllers.inputs[0].set('keyboard', { turbo: Button.A });
    controllers.turboOn = true;
    expect(readButtons(controllers)).toBe(Button.A);
    controllers.turboOn = false;
    expect(readButtons(controllers)).toBe(0);
  });
});

describe('gamepads', () => {
  it('reads a standard pad: D-pad and stick, B and A by position, Select and Start, turbo', () => {
    const state = readGamepad(pad({ pressed: [12, 0, 9, 3], axes: [0.9, 0, 0, 0] }));
    expect(state.buttons).toBe(Button.Up | Button.Right | Button.B | Button.Start);
    expect(state.turbo).toBe(Button.A);
  });

  it('reads a hat switch on a pad without the standard mapping', () => {
    expect(hatDirections(-1)).toBe(Button.Up);
    expect(hatDirections(1.28)).toBe(0);
    const resting = pad({ id: 'Generic pad', mapping: '', axes: [0, 0, 1.28] });
    expect(readGamepad(resting).buttons).toBe(0);
    const right = pad({ id: 'Generic pad', mapping: '', axes: [0, 0, -1 + (2 / 7) * 2] });
    expect(readGamepad(right).buttons).toBe(Button.Right);
  });

  it('orders pads by when they were connected', () => {
    let pads: (GamepadLike | null)[] = [null, pad({ index: 1, id: 'second' })];
    const manager = new GamepadManager(() => pads);
    expect(manager.connected().map((p) => p.id)).toEqual(['second']);
    pads = [pad({ index: 0, id: 'first' }), pads[1]];
    expect(manager.connected().map((p) => p.id)).toEqual(['second', 'first']);
  });
});
