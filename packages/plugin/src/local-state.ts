import type { FullIndexResponse } from "@obsidian-cf-sync/protocol";

const DB_NAME_PREFIX = "obsidian-cf-sync";
const DB_VERSION = 1;

export interface LocalStateScope {
  workerUrl: string;
  vaultId: string;
  deviceId: string;
}

/**
 * Local sync metadata must never be shared between different remote vaults or
 * devices. The encoded identity keeps database names valid even when a Worker
 * is served from a path-prefixed development URL.
 */
export function localStateDatabaseName(scope: LocalStateScope): string {
  const workerUrl = new URL(scope.workerUrl);
  workerUrl.hash = "";
  workerUrl.search = "";
  workerUrl.pathname = workerUrl.pathname.replace(/\/+$/, "") || "/";

  const identity = JSON.stringify({
    workerUrl: workerUrl.toString(),
    vaultId: scope.vaultId,
    deviceId: scope.deviceId,
  });
  return `${DB_NAME_PREFIX}:${encodeURIComponent(identity)}`;
}

export interface LocalFileEntry {
  path: string;
  chunks: string[];
  mtime: number;
  fileVersion: number;
  globalVersion: number;
  deleted: boolean;
}

export interface SyncState {
  globalVersion: number;
  lastFullSync: number;
}

export interface PendingOp {
  opId: string;
  action: "put" | "delete" | "rename";
  path: string;
  oldPath?: string;
  baseFileVersion: number;
  oldBaseFileVersion?: number;
  chunks: string[];
  mtime: number;
  size: number;
  createdAt: number;
  /** Once sent, the operation and its ID are immutable, even after a lost response. */
  attempted?: boolean;
}

function openDB(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
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

function pendingOpPaths(op: PendingOp): string[] {
  return op.oldPath ? [op.path, op.oldPath] : [op.path];
}

function txReplacePendingOp(db: IDBDatabase, op: PendingOp): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingOps", "readwrite");
    const store = tx.objectStore("pendingOps");
    const request = store.getAll();
    request.onsuccess = () => {
      const affectedPaths = new Set(pendingOpPaths(op));
      const existingOps = request.result as PendingOp[];
      for (const existing of existingOps) {
        if (existing.attempted && existing.opId === op.opId) {
          tx.abort();
          return;
        }
        if (
          !existing.attempted &&
          pendingOpPaths(existing).some((path) => affectedPaths.has(path))
        ) {
          store.delete(existing.opId);
        }
      }
      // Preserve a deterministic dependency order even for events in the same millisecond.
      const createdAt = Math.max(
        op.createdAt,
        ...existingOps.map((existing) => existing.createdAt + 1),
      );
      store.put({ ...op, createdAt });
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class LocalState {
  private db!: IDBDatabase;
  private readonly databaseName: string;

  constructor(scope: LocalStateScope) {
    this.databaseName = localStateDatabaseName(scope);
  }

  async init(): Promise<void> {
    this.db = await openDB(this.databaseName);
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

  async hasSyncState(): Promise<boolean> {
    return (await txGet<SyncState>(this.db, "syncState", "sync")) !== undefined;
  }

  async updateSyncState(patch: Partial<SyncState>): Promise<void> {
    const current = await this.getSyncState();
    return txPut(this.db, "syncState", { ...current, ...patch, key: "sync" });
  }

  async getPendingOps(): Promise<PendingOp[]> {
    const ops = await txGetAll<PendingOp>(this.db, "pendingOps");
    return ops.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  async getPendingOpAffectingPath(path: string): Promise<PendingOp | undefined> {
    const ops = await this.getPendingOps();
    return ops.findLast((op) => pendingOpPaths(op).includes(path));
  }

  async replacePendingOp(op: PendingOp): Promise<void> {
    return txReplacePendingOp(this.db, op);
  }

  async beginPendingAttempt(opId: string): Promise<PendingOp | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("pendingOps", "readwrite");
      const store = tx.objectStore("pendingOps");
      const request = store.get(opId);
      let op: PendingOp | undefined;
      request.onsuccess = () => {
        const current = request.result as PendingOp | undefined;
        if (current) {
          op = { ...current, attempted: true };
          store.put(op);
        }
      };
      tx.oncomplete = () => resolve(op);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async getBootstrap(): Promise<FullIndexResponse | undefined> {
    return txGet<FullIndexResponse>(this.db, "syncState", "bootstrap");
  }

  async putBootstrap(index: FullIndexResponse): Promise<void> {
    return txPut(this.db, "syncState", { ...index, key: "bootstrap" });
  }

  async clearBootstrap(): Promise<void> {
    return txDelete(this.db, "syncState", "bootstrap");
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
