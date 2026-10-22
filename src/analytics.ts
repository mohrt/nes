type Gtag = (command: 'event', name: string, params: Record<string, string>) => void;

/**
 * Reports a game starting to Google Analytics. Only bundled games are named, so a
 * player's own file names stay private. Does nothing when the tag is blocked.
 */
export function trackGameLoaded(system: string, bundledTitle?: string): void {
  const gtag = (globalThis as { gtag?: Gtag }).gtag;
  gtag?.('event', 'game_loaded', { system, game: bundledTitle ?? 'own file' });
}
