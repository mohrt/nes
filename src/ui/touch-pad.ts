import { Button, type ControllerInput } from '../io/controllers';

const SOURCE = 'screen-pad';
/** Inside this fraction of the D-pad's radius, no direction is pressed. */
const DEAD_ZONE = 0.25;
/** D-pad directions by 45-degree sector, clockwise from the right (screen y points down). */
const SECTORS = [
  Button.Right,
  Button.Right | Button.Down,
  Button.Down,
  Button.Down | Button.Left,
  Button.Left,
  Button.Left | Button.Up,
  Button.Up,
  Button.Up | Button.Right,
];

/**
 * An on-screen NES controller for touch screens and mice: a D-pad you can
 * slide around on (diagonals included), Select, Start, B and A. It presses
 * buttons on one player's controller, chosen with `setController`.
 */
export class OnScreenPad {
  private readonly pointers = new Map<number, number>();
  private controller: ControllerInput;

  constructor(
    root: HTMLElement,
    controller: ControllerInput,
    private readonly focusScreen: () => void,
  ) {
    this.controller = controller;
    const dpad = root.querySelector<HTMLElement>('.pad-dpad');
    if (!dpad) throw new Error('On-screen pad is missing .pad-dpad');
    this.attachDpad(dpad);
    root.querySelectorAll<HTMLButtonElement>('[data-button]').forEach((button) => {
      const bit = Button[button.dataset.button as keyof typeof Button];
      if (bit) this.attachButton(button, () => bit);
    });
  }

  /** Moves the pad to another player's controller. */
  setController(controller: ControllerInput): void {
    this.controller.clear(SOURCE);
    this.controller = controller;
    this.update();
  }

  private attachDpad(dpad: HTMLElement): void {
    const directions = (event: PointerEvent): number => {
      const box = dpad.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * 2 - 1;
      const y = ((event.clientY - box.top) / box.height) * 2 - 1;
      if (Math.hypot(x, y) < DEAD_ZONE) return 0;
      // Eight sectors of 45 degrees, so diagonals are as easy to hit as the four directions.
      const sector = Math.round(Math.atan2(y, x) / (Math.PI / 4));
      return SECTORS[(sector + 8) % 8];
    };
    this.attachButton(dpad, directions, true);
  }

  private attachButton(element: HTMLElement, buttons: (event: PointerEvent) => number, tracksMovement = false): void {
    const press = (event: PointerEvent) => {
      const bits = buttons(event);
      this.pointers.set(event.pointerId, bits);
      element.dataset.dirs = String(bits);
      this.update();
    };
    element.addEventListener('pointerdown', (event) => {
      element.setPointerCapture(event.pointerId);
      event.preventDefault();
      element.classList.add('active');
      press(event);
    });
    if (tracksMovement) {
      element.addEventListener('pointermove', (event) => {
        if (this.pointers.has(event.pointerId)) press(event);
      });
    }
    const release = (event: PointerEvent) => {
      if (!this.pointers.delete(event.pointerId)) return;
      element.classList.remove('active');
      delete element.dataset.dirs;
      this.update();
      this.focusScreen();
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', release);
  }

  private update(): void {
    let buttons = 0;
    for (const bits of this.pointers.values()) buttons |= bits;
    this.controller.set(SOURCE, { buttons });
  }
}
