/**
 * Freely distributable games a site can offer, listed in `games/index.json`:
 *
 *   { "games": [{ "title": "Some Game", "file": "some-game.nes" }] }
 *
 * `file` is relative to `games/`. Entries may also give a `credit`, a `license`
 * with a `licenseUrl`, a `sourceUrl` and a short `hint` about the game.
 * Without the manifest no games are offered.
 */
export interface BundledGame {
  title: string;
  file: string;
  credit?: string;
  license?: string;
  /** An https:// address, or a file in `games/` (given as `games/...`). */
  licenseUrl?: string;
  sourceUrl?: string;
  hint?: string;
}

const GAMES_DIR = 'games/';

/** Plain relative paths only, so the manifest can't point outside the games folder. */
function isSafeGamePath(file: string): boolean {
  return /^[\w][\w .()+-]*(\/[\w][\w .()+-]*)*$/.test(file) && !file.split('/').includes('..');
}

const optionalText = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Links may go to https:// sites or to files in the games folder. */
function optionalLink(value: unknown): string | undefined {
  const link = optionalText(value);
  if (!link) return undefined;
  if (link.startsWith('https://')) return link;
  return link.startsWith(GAMES_DIR) && isSafeGamePath(link.slice(GAMES_DIR.length)) ? link : undefined;
}

/** The well-formed entries of a manifest; anything else is ignored. */
export function parseGameManifest(json: unknown): BundledGame[] {
  const games = (json as { games?: unknown } | null)?.games;
  if (!Array.isArray(games)) return [];
  return games.flatMap((entry: unknown) => {
    const fields = (entry ?? {}) as Record<string, unknown>;
    const title = optionalText(fields.title);
    const file = fields.file;
    if (!title || typeof file !== 'string' || !isSafeGamePath(file)) return [];
    const game: BundledGame = { title, file };
    const extras = {
      credit: optionalText(fields.credit),
      license: optionalText(fields.license),
      licenseUrl: optionalLink(fields.licenseUrl),
      sourceUrl: optionalLink(fields.sourceUrl),
      hint: optionalText(fields.hint),
    };
    for (const [key, value] of Object.entries(extras)) if (value) Object.assign(game, { [key]: value });
    return [game];
  });
}

/** The site's game list, or none if it has no (valid) manifest. */
export async function loadGameManifest(baseUrl: string): Promise<BundledGame[]> {
  try {
    const response = await fetch(`${baseUrl}${GAMES_DIR}index.json`);
    if (!response.ok) return [];
    return parseGameManifest(await response.json());
  } catch {
    return [];
  }
}

export async function fetchGame(baseUrl: string, game: BundledGame): Promise<File> {
  const response = await fetch(`${baseUrl}${GAMES_DIR}${game.file}`);
  // Some servers (like the dev server) answer missing files with the page itself.
  const isPage = response.headers.get('content-type')?.includes('text/html') ?? false;
  if (!response.ok || isPage) throw new Error(`Could not download ${game.title} (${isPage ? 'not found' : `HTTP ${response.status}`}).`);
  const name = game.file.slice(game.file.lastIndexOf('/') + 1);
  return new File([await response.arrayBuffer()], name);
}
