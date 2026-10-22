// Downloads the freely distributable games listed in games-catalog.json into
// public/games/ and writes the index.json the page reads. The files themselves
// are kept out of git; the deploy workflow runs this too. A game whose download
// fails or no longer matches its checksum is left out with a warning.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { readZip } from '../src/cart/zip.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '..', 'public', 'games');
const catalog = JSON.parse(await readFile(join(scriptDir, 'games-catalog.json'), 'utf8'));

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fromZip(zip, name) {
  const entry = readZip(new Uint8Array(zip)).find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`the zip has no ${name}`);
  return Buffer.from(await entry.read());
}

await mkdir(outDir, { recursive: true });
const games = [];
for (const game of catalog.games) {
  try {
    const downloaded = await download(game.url);
    let bytes = downloaded;
    if (game.gzip) bytes = gunzipSync(bytes);
    if (game.zipEntry) bytes = await fromZip(downloaded, game.zipEntry);
    if (sha256(bytes) !== game.sha256) throw new Error('the download has changed (checksum mismatch)');
    await writeFile(join(outDir, game.file), bytes);

    let licenseUrl = game.licenseUrl;
    if (game.licenseFile || game.licenseZipEntry) {
      // Licences such as MIT and GPL must be shipped with the copies.
      const licenseName = `${game.file}.license.txt`;
      const license = game.licenseZipEntry ? await fromZip(downloaded, game.licenseZipEntry) : await download(game.licenseFile);
      await writeFile(join(outDir, licenseName), license);
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
