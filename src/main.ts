import { AudioOutput } from './audio/audio-output';
import type { Cartridge } from './cart/cartridge';
import { createCartridge, mapperName } from './cart/create';
import { parseInes, regionFromFileName, type Region, type RomInfo } from './cart/ines';
import { BATTERY_EXTENSION, STATE_EXTENSION, filesFrom, readMedia, titleFromFileName } from './cart/load';
import { Emulator } from './emulator';
import { fetchGame, loadGameManifest, type BundledGame } from './games';
import { GamepadManager, padName, readGamepad } from './io/gamepad-input';
import { KeyboardInput } from './io/keyboard-input';
import { Screen, screenAspect } from './render/screen';
import { BatterySaves, batteryKey } from './storage/battery-saves';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from './storage/save-states';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { CartPanel } from './ui/cart-panel';
import { downloadFile } from './ui/download';
import { Settings } from './ui/settings';
import { attachToolbar } from './ui/toolbar';
import { OnScreenPad } from './ui/touch-pad';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = ['tv', 'show-pad', 'pad-player', 'crop-overscan', 'sound', 'volume'];

/** Longest gap the loop catches up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_FRAME_MS = 100;
const PLAYERS = 2;
/** How often changed battery saves are written to browser storage. */
const BATTERY_SAVE_INTERVAL_MS = 2000;

interface CurrentCartridge {
  image: Uint8Array;
  fileName: string;
  title: string;
  /** The TV system the cartridge asks for (header, then file name), if it says. */
  region: Region | null;
  cartridge: Cartridge;
  batteryKey: string;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'nes';

const sizeLabel = (bytes: number) => (bytes >= 1024 ? `${bytes / 1024}K` : `${bytes} bytes`);

/** One line about the cartridge's hardware, e.g. "MMC1 (mapper 1) · 256K PRG · 8K CHR RAM · battery save". */
function describe(info: RomInfo, region: Region | null): string {
  const parts = [
    `${mapperName(info.mapper)} (mapper ${info.mapper})`,
    `${sizeLabel(info.prg.length)} PRG`,
    info.chr.length > 0 ? `${sizeLabel(info.chr.length)} CHR` : `${sizeLabel(info.chrRamSize)} CHR RAM`,
  ];
  if (info.battery) parts.push('battery save');
  if (region === 'pal') parts.push('PAL');
  return parts.join(' · ');
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');

  try {
    const settings = new Settings();
    // The on-screen controller starts out shown on touch screens, until the player chooses.
    const showPad = requireElement<HTMLInputElement>('input[name="show-pad"]');
    showPad.checked = matchMedia('(pointer: coarse)').matches;
    settings.bind(document, REMEMBERED_SETTINGS);

    const screen = new Screen(canvas);
    const emulator = new Emulator(screen);
    const machine = emulator.machine;
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    if (audio) emulator.setAudioRate(audio.sampleRate);

    const stores = await openBrowserStores().catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      return memoryStores();
    });
    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);
    const batterySaves = new BatterySaves(stores.battery as KeyValueStore<Uint8Array>);

    let current: CurrentCartridge | null = null;
    let bundledGames: BundledGame[] = [];
    let paused = false;
    const focusScreen = () => canvas.focus();

    const updateStatus = () => {
      const what = current ? current.title : 'No cartridge';
      status.textContent = `${what} · ${machine.region.toUpperCase()} · Arrows, Z, X, Enter and Shift play`;
      screenFrame.classList.toggle('empty', current === null);
    };

    const regionFor = (cart: CurrentCartridge | null): Region =>
      toolbar.tv !== 'auto' ? toolbar.tv : (cart?.region ?? 'ntsc');

    // --- Battery saves ---------------------------------------------------------------
    const saveBattery = async () => {
      const cart = current?.cartridge;
      const data = cart?.saveData;
      if (!current || !cart || !data || !cart.batteryDirty) return;
      cart.batteryDirty = false;
      await batterySaves.save(current.batteryKey, data);
    };
    const saveBatterySoon = () => void saveBattery().catch((error: unknown) => console.warn('Could not keep the game save:', error));
    setInterval(saveBatterySoon, BATTERY_SAVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveBatterySoon();
    });
    window.addEventListener('pagehide', saveBatterySoon);

    // --- Cartridges ------------------------------------------------------------------
    const loadCartridge = async (image: Uint8Array, fileName: string, knownTitle?: string): Promise<CurrentCartridge> => {
      const info = parseInes(image);
      const cartridge = createCartridge(info);
      const key = batteryKey(image);
      if (cartridge.saveData) {
        const saved = await batterySaves.load(key).catch(() => undefined);
        if (saved) cartridge.loadSaveData(saved);
      }
      const title = knownTitle ?? titleFromFileName(fileName.split(' from ')[0]);
      const region = info.region ?? regionFromFileName(fileName);
      cartPanel.showCartridge(title, fileName, describe(info, region), info.battery);
      return { image, fileName, title, region, cartridge, batteryKey: key };
    };

    const insertImage = async (image: Uint8Array, fileName: string, knownTitle?: string) => {
      const next = await loadCartridge(image, fileName, knownTitle);
      await saveBattery();
      current = next;
      machine.insertCartridge(next.cartridge);
      emulator.setRegion(regionFor(next));
      emulator.resetTiming();
      audio?.flush();
      updateCanSave();
      updateStatus();
    };

    const eject = () => {
      saveBatterySoon();
      machine.insertCartridge(null);
      current = null;
      cartPanel.showEmpty();
      updateCanSave();
      updateStatus();
    };

    const useBatteryFile = async (bytes: Uint8Array) => {
      const cart = current?.cartridge;
      if (!current || !cart) throw new Error('Insert the game first, then drop its .sav file.');
      if (!cart.saveData) throw new Error(`${current.title} doesn't save to its cartridge.`);
      cart.loadSaveData(bytes);
      cart.batteryDirty = true;
      await saveBattery();
      machine.powerOn();
      audio?.flush();
      cartPanel.showMessage('Game save loaded; the console was switched off and on to use it.', true);
    };

    // --- Save states -----------------------------------------------------------------
    const currentSession = (): Session => {
      if (!current) throw new Error('Insert a cartridge first.');
      return { machine: machine.saveState(), rom: current.image, romName: current.fileName, title: current.title };
    };
    const restoreSession = async (session: Session) => {
      const next = await loadCartridge(session.rom, session.romName, session.title);
      await saveBattery();
      current = next;
      machine.insertCartridge(next.cartridge);
      machine.loadState(session.machine);
      emulator.restored();
      updateCanSave();
      audio?.flush();
      updateStatus();
    };
    const updateCanSave = () => toolbar.setCanSave(current !== null);

    // --- Panels ----------------------------------------------------------------------
    const cartPanel = new CartPanel(requireElement('#cart-panel'), {
      onFile: async (file) => {
        const files = await filesFrom(file);
        const fromZip = files[0] !== file;
        const chosen = files[0];
        if (fromZip) cartPanel.setZipFiles(files, chosen.name);
        else if (cartPanel.zipContents.includes(file)) cartPanel.setZipFiles(cartPanel.zipContents, file.name);
        else cartPanel.setZipFiles([], null);
        const media = await readMedia(chosen);
        if (media.kind === 'state') {
          await restoreSession(await decodeSession(media.bytes));
          toolbar.showMessage('Save state loaded');
          return;
        }
        if (media.kind === 'battery') {
          await useBatteryFile(media.bytes);
          return;
        }
        const game = bundledGames.find((entry) => entry.file.split('/').pop() === chosen.name);
        await insertImage(media.image, fromZip ? `${chosen.name} from ${file.name}` : chosen.name, game?.title);
      },
      onGame: (index) => fetchGame(import.meta.env.BASE_URL, bundledGames[index]),
      onEject: eject,
      onExportSave: () => {
        const data = current?.cartridge.saveData;
        if (current && data) downloadFile(data, `${slug(current.title)}${BATTERY_EXTENSION}`);
      },
      focusScreen,
    });

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const toolbar = attachToolbar(requireElement('#toolbar'), {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        emulator.resetTiming();
        audio?.flush();
      },
      onReset: () => machine.pressReset(),
      onPowerCycle: () => {
        machine.powerOn();
        audio?.flush();
      },
      onFullscreen: () => {
        if (document.fullscreenElement) {
          void document.exitFullscreen();
          return;
        }
        void screenFrame.requestFullscreen().then(focusScreen);
      },
      onTv: () => {
        emulator.setRegion(regionFor(current));
        updateStatus();
      },
      onSaveState: async () => {
        const session = currentSession();
        await saveStates.add(session.title, session);
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const session = await saveStates.load(id);
        if (!session) throw new Error('That save state no longer exists.');
        await restoreSession(session);
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        const session = currentSession();
        downloadFile(await encodeSession(session), `${slug(session.title)}${STATE_EXTENSION}`);
      },
      onImportState: async (file) => {
        await restoreSession(await decodeSession(new Uint8Array(await file.arrayBuffer())));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen,
    });
    await refreshStates();

    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games;
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      cartPanel.setGames(games.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })));
    });

    // --- Display -----------------------------------------------------------------------
    const cropOverscan = requireElement<HTMLInputElement>('input[name="crop-overscan"]');
    const applyCrop = () => {
      screen.setCropOverscan(cropOverscan.checked);
      document.documentElement.style.setProperty('--screen-aspect', screenAspect(cropOverscan.checked).toFixed(4));
    };
    cropOverscan.addEventListener('change', () => {
      applyCrop();
      focusScreen();
    });
    applyCrop();

    // --- Inputs ----------------------------------------------------------------------
    const [player1, player2] = machine.controllers.inputs;
    new KeyboardInput(player1, { onPause: () => toolbar.setPaused(!toolbar.paused) }).attach(window);
    const gamepads = new GamepadManager();
    gamepads.attach(window);
    const gamepadStatus = requireElement<HTMLElement>('.gamepad-status');

    const padRoot = requireElement<HTMLElement>('#pad');
    const pad = new OnScreenPad(padRoot, player1, focusScreen);
    const padPlayer = requireElement<HTMLSelectElement>('select[name="pad-player"]');
    const applyPad = () => {
      padRoot.hidden = !showPad.checked;
      pad.setController(padPlayer.value === '1' ? player2 : player1);
    };
    showPad.addEventListener('change', applyPad);
    padPlayer.addEventListener('change', applyPad);
    applyPad();

    const sound = requireElement<HTMLInputElement>('input[name="sound"]');
    const volume = requireElement<HTMLInputElement>('input[name="volume"]');
    const soundHint = requireElement<HTMLElement>('.sound-hint');
    const applySound = () => {
      audio?.setEnabled(sound.checked);
      audio?.setVolume(Number(volume.value));
    };
    sound.addEventListener('change', applySound);
    volume.addEventListener('input', applySound);
    applySound();
    if (!audio) {
      sound.disabled = volume.disabled = true;
      soundHint.textContent = 'Sound is not supported in this browser';
      soundHint.hidden = false;
    } else if (!audio.running) {
      soundHint.hidden = false;
      audio.resumeOnGesture(window, () => (soundHint.hidden = true));
    }

    // --- Main loop -----------------------------------------------------------------
    let lastPadNames = '';
    const pollGamepads = () => {
      const pads = gamepads.connected();
      for (let player = 0; player < PLAYERS; player++) {
        const gamepad = pads[player];
        const input = machine.controllers.inputs[player];
        if (gamepad) input.set('gamepad', readGamepad(gamepad));
        else input.clear('gamepad');
      }
      const names = pads
        .slice(0, PLAYERS)
        .map((gamepad, player) => `Player ${player + 1}: ${padName(gamepad)}`)
        .join(' · ');
      if (names !== lastPadNames) {
        lastPadNames = names;
        gamepadStatus.textContent = names;
      }
    };

    let last = performance.now();
    const frame = (now: number) => {
      const elapsed = Math.min(now - last, MAX_FRAME_MS);
      last = now;
      pollGamepads();
      if (!paused) {
        emulator.run(elapsed);
        audio?.play(emulator.takeAudioSamples());
      }
      screen.present();
      requestAnimationFrame(frame);
    };

    cartPanel.showEmpty();
    updateCanSave();
    updateStatus();
    focusScreen();
    requestAnimationFrame(frame);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
