const DB_NAME = "obsidian-cf-sync";
const DB_VERSION = 1;

export interface LocalFileEntry {
  path: string;
  chunks: string[];
  mtime: number;
  fileVersion: number;
  globalVersion: number;
}

export interface SyncState {
  globalVersion: number;
  lastFullSync: number;
}

export interface PendingOp {
  opId: string;
  action: "update" | "delete" | "rename";
  path: string;
  oldPath?: string;
  baseFileVersion: number;
  chunks: string[];
  mtime: number;
  size: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "path" });
      }
      if (!db.objectStoreNames.contains("syncState")) {
        db.createObjectStore("syncState", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("pendingOps")) {
        db.createObjectStore("pendingOps", { keyPath: "opId" });
      }
      if (!db.objectStoreNames.contains("chunkCache")) {
        db.createObjectStore("chunkCache", { keyPath: "hash" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function txPut<T>(db: IDBDatabase, store: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function txDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function txGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export class LocalState {
  private db!: IDBDatabase;

  async init(): Promise<void> {
    this.db = await openDB();
  }

  async getFile(path: string): Promise<LocalFileEntry | undefined> {
    return txGet<LocalFileEntry>(this.db, "files", path);
  }

  async putFile(entry: LocalFileEntry): Promise<void> {
    return txPut(this.db, "files", entry);
  }

  async deleteFile(path: string): Promise<void> {
    return txDelete(this.db, "files", path);
  }

  async getAllFiles(): Promise<LocalFileEntry[]> {
    return txGetAll<LocalFileEntry>(this.db, "files");
  }

  async getSyncState(): Promise<SyncState> {
    const state = await txGet<SyncState>(this.db, "syncState", "sync");
    return state ?? { globalVersion: 0, lastFullSync: 0 };
  }

  async updateSyncState(patch: Partial<SyncState>): Promise<void> {
    const current = await this.getSyncState();
    return txPut(this.db, "syncState", { ...current, ...patch, key: "sync" });
  }

  async getPendingOps(): Promise<PendingOp[]> {
    return txGetAll<PendingOp>(this.db, "pendingOps");
  }

  async addPendingOp(op: PendingOp): Promise<void> {
    return txPut(this.db, "pendingOps", op);
  }

  async removePendingOp(opId: string): Promise<void> {
    return txDelete(this.db, "pendingOps", opId);
  }

  async hasChunk(hash: string): Promise<boolean> {
    const entry = await txGet(this.db, "chunkCache", hash);
    return entry !== undefined;
  }

  async markChunkCached(hash: string): Promise<void> {
    return txPut(this.db, "chunkCache", { hash, cachedAt: Date.now() });
  }

  async getChunkData(hash: string): Promise<ArrayBuffer | undefined> {
    const entry = await txGet<{ hash: string; data: ArrayBuffer }>(this.db, "chunkCache", hash);
    return entry?.data;
  }

  async putChunkData(hash: string, data: ArrayBuffer): Promise<void> {
    return txPut(this.db, "chunkCache", { hash, data, cachedAt: Date.now() });
  }
}
