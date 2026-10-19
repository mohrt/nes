import { HEADER_SIZE } from '../cart/ines';
import { crc32 } from '../util/crc32';
import type { KeyValueStore } from './store';

/** Battery saves are kept per game, by the CRC-32 of the ROM (header left out, so re-headered copies share). */
export function batteryKey(image: Uint8Array): string {
  return `crc-${crc32(image.subarray(HEADER_SIZE)).toString(16).padStart(8, '0')}`;
}

/** The games' own saves (battery-backed cartridge RAM), kept in browser storage. */
export class BatterySaves {
  constructor(private readonly store: KeyValueStore<Uint8Array>) {}

  load(key: string): Promise<Uint8Array | undefined> {
    return this.store.get(key);
  }

  save(key: string, data: Uint8Array): Promise<void> {
    return this.store.put(key, data.slice());
  }

  forget(key: string): Promise<void> {
    return this.store.delete(key);
  }
}
