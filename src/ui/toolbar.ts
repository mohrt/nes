import type { SaveStateInfo } from '../storage/save-states';

/** 'auto' follows the cartridge (its header, or its file name). */
export type TvChoice = 'auto' | 'ntsc' | 'pal';

export interface ToolbarCallbacks {
  onPause(paused: boolean): void;
  /** The console's reset button. */
  onReset(): void;
  /** Switches the console off and on, keeping the cartridge in. */
  onPowerCycle(): void;
  onFullscreen(): void;
  onTv(tv: TvChoice): void;
  onSaveState(): Promise<void>;
  onLoadState(id: string): Promise<void>;
  onDeleteState(id: string): Promise<void>;
  onExportState(): Promise<void>;
  onImportState(file: File): Promise<void>;
  /** Gives keyboard focus back to the emulator screen. */
  focusScreen(): void;
}

export interface Toolbar {
  readonly paused: boolean;
  readonly tv: TvChoice;
  setPaused(paused: boolean): void;
  setStates(states: SaveStateInfo[]): void;
  /** Saving needs a cartridge in. */
  setCanSave(canSave: boolean): void;
  showMessage(text: string, isError?: boolean): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Toolbar is missing ${selector}`);
  return element;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

/** The row of console controls under the screen. */
export function attachToolbar(root: HTMLElement, callbacks: ToolbarCallbacks): Toolbar {
  const slots = requireChild<HTMLSelectElement>(root, 'select[name="state-slot"]');
  const fileInput = requireChild<HTMLInputElement>(root, 'input[name="state-file"]');
  const message = requireChild<HTMLElement>(root, '.toolbar-message');
  const tv = requireChild<HTMLSelectElement>(root, 'select[name="tv"]');
  const pauseButton = requireChild<HTMLButtonElement>(root, '[data-action="pause"]');
  const saveButton = requireChild<HTMLButtonElement>(root, '[data-action="save-state"]');
  const exportButton = requireChild<HTMLButtonElement>(root, '[data-action="export-state"]');
  const stateButtons = ['load-state', 'delete-state'].map((action) =>
    requireChild<HTMLButtonElement>(root, `[data-action="${action}"]`),
  );
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;

  const showMessage = (text: string, isError = false) => {
    clearTimeout(messageTimer);
    message.textContent = text;
    message.classList.toggle('error', isError);
    if (!isError) messageTimer = setTimeout(() => (message.textContent = ''), 4000);
  };

  const run = (action: () => Promise<void>) => {
    action()
      .catch((error: unknown) => showMessage(error instanceof Error ? error.message : String(error), true))
      .finally(() => callbacks.focusScreen());
  };
  const onClick = (action: string, handler: () => Promise<void>) =>
    requireChild<HTMLButtonElement>(root, `[data-action="${action}"]`).addEventListener('click', () => run(handler));

  const setPaused = (value: boolean) => {
    paused = value;
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    callbacks.onPause(paused);
  };
  onClick('pause', async () => setPaused(!paused));
  onClick('reset', async () => callbacks.onReset());
  onClick('power', async () => callbacks.onPowerCycle());
  onClick('fullscreen', async () => callbacks.onFullscreen());
  const readTv = (): TvChoice => (tv.value === 'pal' || tv.value === 'ntsc' ? tv.value : 'auto');
  tv.addEventListener('change', () => {
    callbacks.onTv(readTv());
    callbacks.focusScreen();
  });

  onClick('save-state', () => callbacks.onSaveState());
  onClick('load-state', async () => {
    if (slots.value) await callbacks.onLoadState(slots.value);
  });
  onClick('delete-state', async () => {
    const option = slots.selectedOptions[0];
    if (option && confirm(`Delete the save state "${option.textContent}"?`)) await callbacks.onDeleteState(option.value);
  });
  onClick('export-state', () => callbacks.onExportState());
  onClick('import-state', async () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) run(() => callbacks.onImportState(file));
  });

  return {
    get paused() {
      return paused;
    },
    get tv() {
      return readTv();
    },
    setPaused,
    setStates: (states) => {
      slots.replaceChildren(
        ...states.map((state) => {
          const option = document.createElement('option');
          option.value = state.id;
          option.textContent = `${state.name}, ${timeFormat.format(state.created)}`;
          return option;
        }),
      );
      const empty = states.length === 0;
      slots.disabled = empty;
      stateButtons.forEach((button) => (button.disabled = empty));
      if (empty) {
        const option = document.createElement('option');
        option.textContent = 'No save states yet';
        slots.append(option);
      }
    },
    setCanSave: (canSave) => {
      saveButton.disabled = exportButton.disabled = !canSave;
    },
    showMessage,
  };
}
