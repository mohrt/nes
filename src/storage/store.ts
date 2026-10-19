/** A minimal async key-value store, so persistence can be swapped for an in-memory one in tests. */
export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  entries(): Promise<[string, T][]>;
}

export class MemoryStore<T> implements KeyValueStore<T> {
  private readonly data = new Map<string, T>();

  async get(key: string): Promise<T | undefined> {
    return this.data.get(key);
  }

  async put(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async entries(): Promise<[string, T][]> {
    return [...this.data.entries()];
  }
}

const DATABASE_NAME = 'nes-emulator';
const DATABASE_VERSION = 1;
export const STORE_NAMES = ['saveStates', 'battery'] as const;
export type StoreName = (typeof STORE_NAMES)[number];

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class IndexedDbStore<T> implements KeyValueStore<T> {
  constructor(
    private readonly db: IDBDatabase,
    private readonly name: StoreName,
  ) {}

  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(this.name, mode).objectStore(this.name);
  }

  async get(key: string): Promise<T | undefined> {
    return (await request(this.store('readonly').get(key))) as T | undefined;
  }

  async put(key: string, value: T): Promise<void> {
    await request(this.store('readwrite').put(value, key));
  }

  async delete(key: string): Promise<void> {
    await request(this.store('readwrite').delete(key));
  }

  async entries(): Promise<[string, T][]> {
    const store = this.store('readonly');
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return keys.map((key, i) => [String(key), values[i] as T]);
  }
}

/**
 * Opens the browser database. Asks the browser to keep the data even under
 * storage pressure; users can still clear it with the site's data.
 */
export async function openBrowserStores(): Promise<Record<StoreName, KeyValueStore<unknown>>> {
  void navigator.storage?.persist?.();
  const open = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  open.onupgradeneeded = () => {
    for (const name of STORE_NAMES) {
      if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
    }
  };
  const db = await request(open);
  const stores = {} as Record<StoreName, KeyValueStore<unknown>>;
  for (const name of STORE_NAMES) stores[name] = new IndexedDbStore(db, name);
  return stores;
}

/** In-memory stores, used when the browser has no IndexedDB (and in tests). */
export function memoryStores(): Record<StoreName, KeyValueStore<unknown>> {
  return { saveStates: new MemoryStore(), battery: new MemoryStore() };
}
