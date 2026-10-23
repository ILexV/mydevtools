/**
 * Hand-off of files opened from the operating system ("Open with → MyDevTools",
 * PWA `file_handlers`). `/launch/` receives file handles in the language-neutral
 * launch page, parks the handles (references, not contents) in IndexedDB under a
 * one-time key and moves to the localized desk, which takes and deletes them at once.
 */

const DB_NAME = "mdt-launch";
const STORE = "handles";
/** Handles older than this are stale leftovers of an interrupted launch. */
const MAX_AGE_MS = 60_000;

interface Parked {
  handles: FileSystemFileHandle[];
  at: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function parkLaunchHandles(handles: FileSystemFileHandle[]): Promise<string> {
  const key = crypto.randomUUID();
  const db = await openDb();
  try {
    await run(db, "readwrite", (store) => store.clear());
    await run(db, "readwrite", (store) => store.put({ handles, at: Date.now() } satisfies Parked, key));
  } finally {
    db.close();
  }
  return key;
}

/** Reads and deletes the parked handles; unreadable or stale entries give no files. */
export async function takeLaunchFiles(key: string): Promise<File[]> {
  if (!/^[0-9a-f-]{36}$/.test(key) || typeof indexedDB === "undefined") return [];
  let parked: Parked | undefined;
  try {
    const db = await openDb();
    try {
      parked = await run<Parked | undefined>(db, "readonly", (store) => store.get(key) as IDBRequest<Parked | undefined>);
      await run(db, "readwrite", (store) => store.clear());
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
  if (!parked || Date.now() - parked.at > MAX_AGE_MS) return [];
  const files: File[] = [];
  for (const handle of parked.handles) {
    try {
      files.push(await handle.getFile());
    } catch {
      /* permission withdrawn or file moved: skip it */
    }
  }
  return files;
}
