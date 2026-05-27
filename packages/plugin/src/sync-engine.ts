import { App, Notice, TFile } from "obsidian";
import type { PluginSettings } from "./settings";
import { LocalState, type PendingOp } from "./local-state";
import { ConnectionManager, type WSMessage } from "./connection";
import {
  ChangesResponse as ChangesResponseSchema,
  CommitResponse as CommitResponseSchema,
  FullIndexResponse as FullIndexResponseSchema,
  PrepareResponse as PrepareResponseSchema,
  Schema,
  decodeUnknownSync,
} from "@obsidian-cf-sync/protocol";

const CHUNK_SIZE = 256 * 1024; // 256KB fixed-size chunks for v1

export class SyncEngine {
  private app: App;
  private settings: PluginSettings;
  private localState: LocalState;
  private connection: ConnectionManager;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private applyingRemote = false;

  constructor(app: App, settings: PluginSettings) {
    this.app = app;
    this.settings = settings;
    this.localState = new LocalState();
    this.connection = new ConnectionManager(settings.workerUrl, settings.apiKey, settings.vaultId);
  }

  async start(): Promise<void> {
    await this.localState.init();

    this.connection.onMessage((msg) => this.handleWSMessage(msg));
    this.connection.onConnect(() => {
      void this.syncAfterReconnect();
    });
    this.connection.connect();

    this.app.vault.on("create", (file) => {
      if (file instanceof TFile) this.onFileChange(file);
    });
    this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.onFileChange(file);
    });
    this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) this.onFileDelete(file);
    });
    this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) this.onFileRename(file, oldPath);
    });

    await this.catchUp();
    await this.syncPendingOps();
  }

  stop(): void {
    this.connection.disconnect();
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private onFileChange(file: TFile): void {
    if (this.applyingRemote) return;
    if (!file.path.startsWith(".obsidian/")) {
      this.debounceSync();
    }
  }

  private onFileDelete(file: TFile): void {
    if (this.applyingRemote) return;
    if (!file.path.startsWith(".obsidian/")) {
      void this.queueDelete(file.path);
      this.debounceSync();
    }
  }

  private onFileRename(file: TFile, oldPath: string): void {
    if (this.applyingRemote) return;
    if (!file.path.startsWith(".obsidian/")) {
      void this.queueDelete(oldPath);
      this.debounceSync();
    }
  }

  private async queueDelete(path: string): Promise<void> {
    const localEntry = await this.localState.getFile(path);
    await this.localState.addPendingOp({
      opId: crypto.randomUUID(),
      action: "delete",
      path,
      baseFileVersion: localEntry?.fileVersion ?? 0,
      chunks: [],
      mtime: Date.now(),
      size: 0,
    });
    await this.localState.deleteFile(path);
  }

  private debounceSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.pushChanges();
    }, this.settings.syncInterval);
  }

  private async pushChanges(): Promise<void> {
    if (this.syncing || !this.connection.connected) return;
    this.syncing = true;

    try {
      const files = this.app.vault.getFiles();
      for (const file of files) {
        if (file.path.startsWith(".obsidian/")) continue;
        await this.pushFile(file);
      }
      await this.syncPendingOps();
    } catch (e) {
      console.error("Push failed:", e);
    } finally {
      this.syncing = false;
    }
  }

  private async pushFile(file: TFile): Promise<void> {
    const content = await this.app.vault.readBinary(file);
    const chunks = await this.chunkData(content);
    const chunkHashes = chunks.map((c) => c.hash);

    const localEntry = await this.localState.getFile(file.path);
    const baseFileVersion = localEntry?.fileVersion ?? 0;

    if (localEntry && this.arraysEqual(localEntry.chunks, chunkHashes)) {
      return;
    }

    const opId = crypto.randomUUID();
    const body = {
      opId,
      action: "put" as const,
      file: file.path,
      chunks: chunkHashes,
      mtime: file.stat.mtime,
      size: file.stat.size,
      baseFileVersion,
      deviceId: this.settings.deviceId,
    };

    const prepareResp = await this.apiCall(PrepareResponseSchema, "POST", "/sync/prepare", body);

    if (!prepareResp.success) {
      new Notice(`Sync conflict on ${file.path}`);
      await this.createConflictCopy(file.path, content);
      await this.pullFile(file.path);
      return;
    }

    if (!("alreadyCommitted" in prepareResp)) {
      for (const hash of prepareResp.missing ?? []) {
        const chunk = chunks.find((c) => c.hash === hash);
        if (chunk) {
          await this.uploadChunk(hash, chunk.data);
        }
      }

      const commitResp = await this.apiCall(CommitResponseSchema, "POST", "/sync/commit", body);

      if (!commitResp.success) {
        new Notice(`Sync conflict on ${file.path}`);
        await this.createConflictCopy(file.path, content);
        await this.pullFile(file.path);
        return;
      }

      if (commitResp.success) {
        await this.localState.putFile({
          path: file.path,
          chunks: chunkHashes,
          mtime: file.stat.mtime,
          fileVersion: commitResp.fileVersion,
          globalVersion: commitResp.globalVersion,
        });
        await this.localState.updateSyncState({
          globalVersion: commitResp.globalVersion,
          lastFullSync: Date.now(),
        });
      }
    } else {
      await this.localState.putFile({
        path: file.path,
        chunks: chunkHashes,
        mtime: file.stat.mtime,
        fileVersion: prepareResp.fileVersion,
        globalVersion: prepareResp.globalVersion,
      });
      await this.localState.updateSyncState({
        globalVersion: prepareResp.globalVersion,
        lastFullSync: Date.now(),
      });
    }
  }

  private async handleWSMessage(msg: WSMessage): Promise<void> {
    if (msg.type === "file_changed") {
      const { action, file, deviceId, globalVersion } = msg as {
        type: string;
        action: "put" | "delete";
        file: string;
        fileVersion: number;
        globalVersion: number;
        deviceId: string;
      };

      if (deviceId === this.settings.deviceId) return;

      if (action === "delete") {
        await this.applyDelete(file);
        await this.localState.updateSyncState({
          globalVersion,
          lastFullSync: Date.now(),
        });
      } else {
        await this.pullFile(file);
      }
    }
  }

  private async pullFile(path: string): Promise<void> {
    try {
      const indexResp = await this.apiCall(FullIndexResponseSchema, "GET", "/sync/index");
      const fileEntry = indexResp.files.find((f: { path: string }) => f.path === path);
      if (!fileEntry) return;

      await this.applyFileEntry(fileEntry);
    } catch (e) {
      console.error(`Failed to pull ${path}:`, e);
    }
  }

  private async applyFileEntry(fileEntry: {
    path: string;
    chunks: readonly string[];
    mtime: number;
    fileVersion: number;
    globalVersion: number;
  }): Promise<void> {
    const chunks: ArrayBuffer[] = [];
    for (const hash of fileEntry.chunks) {
      let data = await this.localState.getChunkData(hash);
      if (!data) {
        data = await this.downloadChunk(hash);
        await this.localState.putChunkData(hash, data);
      }
      chunks.push(data);
    }

    const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      assembled.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    this.applyingRemote = true;
    try {
      const existing = this.app.vault.getAbstractFileByPath(fileEntry.path);
      if (existing instanceof TFile) {
        const localEntry = await this.localState.getFile(fileEntry.path);
        const currentContent = await this.app.vault.readBinary(existing);
        const currentChunks = (await this.chunkData(currentContent)).map((chunk) => chunk.hash);
        if (localEntry && !this.arraysEqual(localEntry.chunks, currentChunks)) {
          await this.createConflictCopy(fileEntry.path, currentContent);
        }
        await this.app.vault.modifyBinary(existing, assembled.buffer);
      } else {
        await this.ensureFolder(fileEntry.path);
        await this.app.vault.createBinary(fileEntry.path, assembled.buffer);
      }
    } finally {
      this.applyingRemote = false;
    }

    await this.localState.putFile({
      path: fileEntry.path,
      chunks: Array.from(fileEntry.chunks),
      mtime: fileEntry.mtime,
      fileVersion: fileEntry.fileVersion,
      globalVersion: fileEntry.globalVersion,
    });
    await this.localState.updateSyncState({
      globalVersion: fileEntry.globalVersion,
      lastFullSync: Date.now(),
    });
  }

  private async catchUp(): Promise<void> {
    try {
      const syncState = await this.localState.getSyncState();
      const resp = await this.apiCall(
        ChangesResponseSchema,
        "GET",
        `/sync/changes?since=${syncState.globalVersion}`,
      );

      for (const change of resp.changes) {
        if (change.action === "delete") {
          await this.applyDelete(change.path);
        } else {
          await this.applyFileEntry({
            path: change.path,
            chunks: Array.from(change.chunks),
            mtime: change.mtime,
            fileVersion: change.fileVersion,
            globalVersion: change.globalVersion,
          });
        }
      }

      if (resp.globalVersion > syncState.globalVersion) {
        await this.localState.updateSyncState({
          globalVersion: resp.globalVersion,
          lastFullSync: Date.now(),
        });
      }
    } catch (e) {
      console.error("Catch-up sync failed:", e);
    }
  }

  private async syncPendingOps(): Promise<void> {
    const ops = await this.localState.getPendingOps();
    for (const op of ops) {
      try {
        if (op.action === "delete") {
          await this.commitDelete(op);
        } else {
          const file = this.app.vault.getAbstractFileByPath(op.path);
          if (file instanceof TFile) {
            await this.pushFile(file);
          }
        }
        await this.localState.removePendingOp(op.opId);
      } catch (e) {
        console.error(`Pending op ${op.opId} failed:`, e);
      }
    }
  }

  private async commitDelete(op: PendingOp): Promise<void> {
    const body = {
      opId: op.opId,
      action: "delete" as const,
      file: op.path,
      chunks: [],
      mtime: op.mtime,
      size: 0,
      baseFileVersion: op.baseFileVersion,
      deviceId: this.settings.deviceId,
    };

    const prepareResp = await this.apiCall(PrepareResponseSchema, "POST", "/sync/prepare", body);
    if (!prepareResp.success) {
      new Notice(`Sync conflict deleting ${op.path}`);
      await this.pullFile(op.path);
      return;
    }

    const commitResp =
      "alreadyCommitted" in prepareResp
        ? prepareResp
        : await this.apiCall(CommitResponseSchema, "POST", "/sync/commit", body);
    if (!commitResp.success) {
      new Notice(`Sync conflict deleting ${op.path}`);
      await this.pullFile(op.path);
      return;
    }
    if (commitResp.success) {
      await this.localState.deleteFile(op.path);
      await this.localState.updateSyncState({
        globalVersion: commitResp.globalVersion,
        lastFullSync: Date.now(),
      });
    }
  }

  private async syncAfterReconnect(): Promise<void> {
    await this.catchUp();
    await this.pushChanges();
  }

  private async applyDelete(path: string): Promise<void> {
    this.applyingRemote = true;
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const localEntry = await this.localState.getFile(path);
        const currentContent = await this.app.vault.readBinary(existing);
        const currentChunks = (await this.chunkData(currentContent)).map((chunk) => chunk.hash);
        if (localEntry && !this.arraysEqual(localEntry.chunks, currentChunks)) {
          await this.createConflictCopy(path, currentContent);
        }
        await this.app.vault.delete(existing);
      }
      await this.localState.deleteFile(path);
    } finally {
      this.applyingRemote = false;
    }
  }

  private async chunkData(data: ArrayBuffer): Promise<{ hash: string; data: ArrayBuffer }[]> {
    const chunks: { hash: string; data: ArrayBuffer }[] = [];
    const view = new Uint8Array(data);

    for (let i = 0; i < view.length; i += CHUNK_SIZE) {
      const slice = view.slice(i, Math.min(i + CHUNK_SIZE, view.length));
      const digest = await crypto.subtle.digest("SHA-256", slice);
      const hash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      chunks.push({ hash, data: slice.buffer });
    }

    return chunks;
  }

  private async uploadChunk(hash: string, data: ArrayBuffer): Promise<void> {
    const url = `${this.settings.workerUrl}/sync/chunk/${hash}`;
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        "X-Vault-Id": this.settings.vaultId,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    await this.localState.markChunkCached(hash);
    await this.localState.putChunkData(hash, data);
  }

  private async downloadChunk(hash: string): Promise<ArrayBuffer> {
    const url = `${this.settings.workerUrl}/sync/chunk/${hash}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        "X-Vault-Id": this.settings.vaultId,
      },
    });
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    return resp.arrayBuffer();
  }

  private async apiCall<S extends Schema.Top>(
    schema: S,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Schema.Schema.Type<S>> {
    const url = `${this.settings.workerUrl}${path}`;
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        "X-Vault-Id": this.settings.vaultId,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`API ${path}: ${resp.status}`);
    return (decodeUnknownSync as any)(schema)(await resp.json()) as Schema.Schema.Type<S>;
  }

  private async createConflictCopy(path: string, content: ArrayBuffer): Promise<void> {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const hasExtension = dot > slash;
    const stem = hasExtension ? path.slice(0, dot) : path;
    const ext = hasExtension ? path.slice(dot) : "";

    let candidate = `${stem} (conflict ${new Date().toISOString().replace(/[:.]/g, "-")})${ext}`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${stem} (conflict ${suffix})${ext}`;
      suffix += 1;
    }

    await this.ensureFolder(candidate);
    await this.app.vault.createBinary(candidate, content);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
