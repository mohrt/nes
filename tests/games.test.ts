import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/io/controllers';
import { framePng } from './helpers/png';
import { nesWith } from './helpers/rom';

// Cartridge images are never committed. These run the free games (`npm run fetch:games`
// puts them in public/games/) and any of your own you put in roms/.
const root = join(import.meta.dirname, '..');
const nesFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.nes')).map((name) => join(dir, name)) : [];
const cartridges = [...nesFiles(join(root, 'public', 'games')), ...nesFiles(join(root, 'roms'))];
/** Set SHOTS=<dir> to save screenshots of the title screen and after pressing Start. */
const shotsDir = process.env.SHOTS;
const FPS = 60;
const TITLE_SECONDS = 5;
const PLAY_SECONDS = 10;

describe.skipIf(cartridges.length === 0)('cartridges', () => {
  for (const path of cartridges) {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.nes$/i, '');
    it(`${name} boots, draws a picture and keeps running`, () => {
      const nes = nesWith(new Uint8Array(readFileSync(path)));
      const pad = nes.controllers.inputs[0];
      const shot = (label: string) => {
        if (!shotsDir) return;
        mkdirSync(shotsDir, { recursive: true });
        writeFileSync(join(shotsDir, `${name} - ${label}.png`), framePng(nes.ppu.framebuffer));
      };
      for (let frame = 0; frame < TITLE_SECONDS * FPS; frame++) nes.runFrame();
      shot('title');
      expect(new Set(nes.ppu.framebuffer).size, 'colours on the title screen').toBeGreaterThan(2);
      // Press Start a few times, as a player would, then let it run.
      for (let frame = 0; frame < PLAY_SECONDS * FPS; frame++) {
        pad.set('test', { buttons: frame % 60 < 5 && frame < 4 * FPS ? Button.Start : 0 });
        nes.runFrame();
      }
      shot('later');
      expect(nes.cpu.jammedAt, 'the CPU hit a JAM opcode').toBe(-1);
      expect(nes.ppu.frames).toBeGreaterThan((TITLE_SECONDS + PLAY_SECONDS) * FPS - 2);
    }, 120_000);
  }
});
