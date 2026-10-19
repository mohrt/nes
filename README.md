# NES in the browser

**Play it at [mohrt.github.io/nes](https://mohrt.github.io/nes/)**

A Nintendo Entertainment System emulator written from scratch in TypeScript: a cycle-exact 2A03 CPU (every official and unofficial opcode, with the real chip's interrupt timing), the 2C02 PPU drawn one dot at a time with its real fetch pipeline, the APU's five channels with the console's non-linear mixer, OAM and DMC DMA, and the common cartridge mappers. Drop a `.nes` file (or a `.zip` containing one) onto the page to play it. No BIOS or system ROM is needed.

It passes kevtris's nestest instruction for instruction and cycle for cycle, and blargg's test suites for the CPU's instructions, timing and interrupts, the PPU's vertical blank, NMI, open bus and read buffer, the APU, and the MMC3's scanline counter.

## Controls

- **Keyboard** (player 1): arrow keys for the D-pad, X for A, Z for B, Enter for Start and Shift for Select. S and A are turbo A and turbo B. P or Pause pauses.
- **Gamepads** work as soon as you press one of their buttons: the first is player 1, the second player 2. The D-pad or left stick is the D-pad; the face buttons go by position as on the NES pad, so the bottom one is B and the right one A, and the other two are turbo B and turbo A. Start and Back/Select are Start and Select. Pads without a standard mapping work through their main axes or a hat switch.
- **On-screen controller**: a D-pad you can slide around on, Select, Start, B and A, for player 1 or player 2. It is shown on touch screens, and works with a mouse too.

## Console

The toolbar has pause, the console's reset button, power cycle, full screen and the TV system: Auto takes it from the cartridge header (NES 2.0) or the file name, such as "(Europe)", or you can choose NTSC or PAL. **Hide overscan** crops the 8 lines at the top and bottom that TVs didn't show. Save states keep the whole console, cartridge included, in the browser. They can be exported and imported as `.nesstate` files.

Games that save to their cartridge (battery-backed RAM, as in Zelda) save in the browser by themselves. **Download .sav** gives you the save, and dropping a `.sav` file onto the page while its game is in uses it.

## Cartridges

Supported mappers: NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 (4), AxROM (7), MMC2 (9), MMC4 (10), Color Dreams (11), BNROM / NINA-001 (34), GxROM (66), Camerica (71) and Namco 108 (206). Between them they cover most of the licensed library. iNES and NES 2.0 headers are both read.

No commercial games are included in this repository. Use images of cartridges you own. `npm run fetch:games` downloads the freely licensed homebrews listed in `scripts/games-catalog.json` (each with its credit, licence, source and checksum) into `public/games/`, where they appear in a "Free games" picker. To offer other games, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Game", "file": "some-game.nes" }] }`.

## Development

```sh
npm install
npm run fetch:games       # optional: free games into public/games/
npm run dev               # http://localhost:5173
npm test                  # tests needing downloaded files skip when they're missing
npm run fetch:test-roms   # optional: nestest and blargg's test ROMs, for the accuracy tests
```

`npm test` also runs the free games and any `.nes` files you put in `roms/`; `SHOTS=/tmp/shots npm test` saves screenshots of each.

## Deploying

`.github/workflows/pages.yml` downloads the free games and the test ROMs, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
