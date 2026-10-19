// Downloads the freely distributable games listed in games-catalog.json into
// public/games/ and writes the index.json the page reads. The files themselves
// are kept out of git; the deploy workflow runs this too. A game whose download
// fails or no longer matches its checksum is left out with a warning.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '..', 'public', 'games');
const catalog = JSON.parse(await readFile(join(scriptDir, 'games-catalog.json'), 'utf8'));

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

await mkdir(outDir, { recursive: true });
const games = [];
for (const game of catalog.games) {
  try {
    let bytes = await download(game.url);
    if (game.gzip) bytes = gunzipSync(bytes);
    if (sha256(bytes) !== game.sha256) throw new Error('the download has changed (checksum mismatch)');
    await writeFile(join(outDir, game.file), bytes);

    let licenseUrl = game.licenseUrl;
    if (game.licenseFile) {
      // Licences such as MIT and GPL must be shipped with the copies.
      const licenseName = `${game.file}.license.txt`;
      await writeFile(join(outDir, licenseName), await download(game.licenseFile));
      licenseUrl = `games/${licenseName}`;
    }
    games.push({
      title: game.title,
      file: game.file,
      credit: game.credit,
      license: game.license,
      licenseUrl,
      sourceUrl: game.sourceUrl,
      hint: game.hint,
    });
    console.log(`Saved public/games/${game.file}`);
  } catch (error) {
    console.warn(`Skipping ${game.title}: ${error.message}`);
  }
}

games.sort((a, b) => a.title.localeCompare(b.title));
await writeFile(join(outDir, 'index.json'), `${JSON.stringify({ games }, null, 2)}\n`);
console.log(`Listed ${games.length} of ${catalog.games.length} games in public/games/index.json`);
