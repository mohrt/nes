import type { StateNode } from '../state/snapshot';
import { decodeState, encodeState } from '../state/snapshot';
import type { KeyValueStore } from './store';

/** Everything needed to resume a game: the machine and its cartridge. */
export interface Session {
  machine: StateNode;
  /** The cartridge image (states carry their own, so they can be loaded with any cartridge in). */
  rom: Uint8Array;
  romName: string;
  title: string;
}

export interface SaveStateRecord {
  name: string;
  created: number;
  /** The session, gzipped (the same format as exported .nesstate files). */
  bytes: Uint8Array;
}

export interface SaveStateInfo {
  id: string;
  name: string;
  created: number;
}

/** Older states are dropped beyond this many. */
const MAX_STATES = 30;

/** Save states kept in browser storage, newest first. */
export class SaveStates {
  constructor(private readonly store: KeyValueStore<SaveStateRecord>) {}

  async add(name: string, session: Session): Promise<void> {
    const created = Date.now();
    await this.store.put(`state-${created}`, { name, created, bytes: await encodeSession(session) });
    const all = await this.list();
    for (const old of all.slice(MAX_STATES)) await this.store.delete(old.id);
  }

  async list(): Promise<SaveStateInfo[]> {
    const entries = await this.store.entries();
    return entries.map(([id, record]) => ({ id, name: record.name, created: record.created })).sort((a, b) => b.created - a.created);
  }

  async load(id: string): Promise<Session | null> {
    const record = await this.store.get(id);
    return record ? decodeSession(record.bytes) : null;
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }
}

const MAGIC = 'nes-session';

export async function encodeSession(session: Session): Promise<Uint8Array> {
  return encodeState({ magic: MAGIC, ...session });
}

export async function decodeSession(bytes: Uint8Array): Promise<Session> {
  const decoded = await decodeState<Session & { magic?: string }>(bytes).catch(() => null);
  if (decoded?.magic !== MAGIC) throw new Error('That file is not an NES save state.');
  return decoded;
}
