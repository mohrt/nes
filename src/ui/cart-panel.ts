export interface GameListing {
  title: string;
  credit?: string;
  license?: string;
  licenseHref?: string;
  sourceHref?: string;
  hint?: string;
}

export interface CartPanelCallbacks {
  /** A file was dropped or chosen (a cartridge image, a zip, a save state, or a .sav battery save). */
  onFile(file: File): Promise<void>;
  /** Downloads one of the free games. */
  onGame(index: number): Promise<File>;
  onEject(): void;
  onExportSave(): void;
  focusScreen(): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Cartridge panel is missing ${selector}`);
  return element;
}

/** The cartridge slot: drop or choose files, pick free games, and get at the game's battery save. */
export class CartPanel {
  private readonly fileInput: HTMLInputElement;
  private readonly message: HTMLElement;
  private readonly zipFiles: HTMLElement;
  private readonly zipButtons: HTMLElement;
  private readonly gamePicker: HTMLSelectElement;
  private readonly gameInfo: HTMLElement;
  private games: GameListing[] = [];
  private zipChoices: File[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: CartPanelCallbacks,
  ) {
    this.fileInput = requireChild(root, 'input[name="cart-file"]');
    this.message = requireChild(root, '.cart-message');
    this.zipFiles = requireChild(root, '.zip-files');
    this.zipButtons = requireChild(root, '.zip-buttons');
    this.gamePicker = requireChild(root, 'select[name="bundled-game"]');
    this.gameInfo = requireChild(root, '.game-info');

    this.gamePicker.addEventListener('change', () => this.showGameInfo());
    requireChild<HTMLButtonElement>(root, '[data-action="play-game"]').addEventListener('click', () => {
      const index = Number(this.gamePicker.value);
      this.run(async () => this.callbacks.onFile(await this.callbacks.onGame(index)));
    });
    root.querySelectorAll<HTMLButtonElement>('[data-action="choose"]').forEach((button) =>
      button.addEventListener('click', () => this.fileInput.click()),
    );
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) this.run(() => this.callbacks.onFile(file));
    });
    requireChild<HTMLButtonElement>(root, '[data-action="eject"]').addEventListener('click', () => {
      this.callbacks.onEject();
      this.callbacks.focusScreen();
    });
    requireChild<HTMLButtonElement>(root, '[data-action="export-save"]').addEventListener('click', () => {
      this.callbacks.onExportSave();
      this.callbacks.focusScreen();
    });
    this.attachDragAndDrop();
  }

  /** Files can be dropped anywhere on the page. */
  private attachDragAndDrop(): void {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    document.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      depth++;
      this.root.classList.add('drag-over');
    });
    document.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.root.classList.remove('drag-over');
    });
    document.addEventListener('dragover', (event) => {
      if (hasFiles(event)) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      this.root.classList.remove('drag-over');
      const file = event.dataTransfer?.files[0];
      if (file) this.run(() => this.callbacks.onFile(file));
    });
  }

  private run(action: () => Promise<void>): void {
    this.showMessage('');
    action()
      .catch((error: unknown) => this.showMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => this.callbacks.focusScreen());
  }

  showMessage(text: string, isWarning = false): void {
    this.message.textContent = text;
    this.message.classList.toggle('warning', isWarning);
  }

  /** Shows the cartridge in the slot: its title, file name, a line about its hardware, and whether it saves. */
  showCartridge(title: string, fileLabel: string, details: string, hasBattery: boolean): void {
    this.root.dataset.state = 'loaded';
    requireChild(this.root, '.cart-name').textContent = title;
    requireChild(this.root, '.cart-file').textContent = fileLabel === title ? '' : `(${fileLabel})`;
    requireChild(this.root, '.cart-details').textContent = details;
    requireChild<HTMLElement>(this.root, '.battery-actions').hidden = !hasBattery;
  }

  showEmpty(): void {
    this.root.dataset.state = 'empty';
    this.setZipFiles([], null);
  }

  /** Buttons for the other cartridge images in a zip. */
  setZipFiles(files: File[], current: string | null): void {
    this.zipChoices = files;
    this.zipFiles.hidden = files.length < 2;
    this.zipButtons.replaceChildren(
      ...files.map((file) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = file.name;
        button.classList.toggle('current', file.name === current);
        button.addEventListener('click', () => this.run(() => this.callbacks.onFile(file)));
        return button;
      }),
    );
  }

  get zipContents(): File[] {
    return this.zipChoices;
  }

  setGames(games: GameListing[]): void {
    this.games = games;
    requireChild<HTMLElement>(this.root, '.bundled-games').hidden = games.length === 0;
    this.gamePicker.replaceChildren(
      ...games.map((game, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = game.title;
        return option;
      }),
    );
    this.showGameInfo();
  }

  /** The chosen game's credit, licence, source and hint, with links. */
  private showGameInfo(): void {
    const game = this.games[Number(this.gamePicker.value)];
    this.gameInfo.replaceChildren();
    if (!game) return;
    const link = (href: string, text: string) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.textContent = text;
      return anchor;
    };
    const parts: (string | Node)[] = [];
    if (game.credit) parts.push(game.credit);
    if (game.license) parts.push(game.licenseHref ? link(game.licenseHref, game.license) : game.license);
    if (game.sourceHref) parts.push(link(game.sourceHref, 'source'));
    if (game.hint) parts.push(game.hint);
    parts.forEach((part, i) => {
      if (i > 0) this.gameInfo.append(' · ');
      this.gameInfo.append(part);
    });
  }
}
