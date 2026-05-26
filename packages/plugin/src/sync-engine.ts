import { App, Notice, TFile } from "obsidian";
import type { PluginSettings } from "./settings";
import { LocalState, type PendingOp } from "./local-state";
import { ConnectionManager, type WSMessage } from "./connection";

const CHUNK_SIZE = 256 * 1024; // 256KB fixed-size chunks for v1

export class SyncEngine {
  private app: App;
  private settings: PluginSettings;
  private localState: LocalState;
  private connection: ConnectionManager;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;

  constructor(app: App, settings: PluginSettings) {
    this.app = app;
    this.settings = settings;
    this.localState = new LocalState();
    this.connection = new ConnectionManager(settings.workerUrl, settings.apiKey);
  }

  async start(): Promise<void> {
    await this.localState.init();

    this.connection.onMessage((msg) => this.handleWSMessage(msg));
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

    await this.syncPendingOps();
    await this.catchUp();
  }

  stop(): void {
    this.connection.disconnect();
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private onFileChange(file: TFile): void {
    if (!file.path.startsWith(".obsidian/")) {
      this.debounceSync();
    }
  }

  private onFileDelete(file: TFile): void {
    if (!file.path.startsWith(".obsidian/")) {
      this.debounceSync();
    }
  }

  private onFileRename(file: TFile, oldPath: string): void {
    if (!file.path.startsWith(".obsidian/")) {
      this.debounceSync();
    }
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
      file: file.path,
      chunks: chunkHashes,
      mtime: file.stat.mtime,
      size: file.stat.size,
      baseFileVersion,
      deviceId: this.settings.deviceId,
    };

    const prepareResp = await this.apiCall("POST", "/sync/prepare", body);

    if (prepareResp.conflict) {
      new Notice(`Sync conflict on ${file.path}`);
      return;
    }

    if (!prepareResp.alreadyCommitted) {
      for (const hash of prepareResp.missing ?? []) {
        const chunk = chunks.find((c) => c.hash === hash);
        if (chunk) {
          await this.uploadChunk(hash, chunk.data);
        }
      }

      const commitResp = await this.apiCall("POST", "/sync/commit", body);

      if (commitResp.conflict) {
        new Notice(`Sync conflict on ${file.path}`);
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
      }
    } else {
      await this.localState.putFile({
        path: file.path,
        chunks: chunkHashes,
        mtime: file.stat.mtime,
        fileVersion: prepareResp.globalVersion,
        globalVersion: prepareResp.globalVersion,
      });
    }
  }

  private async handleWSMessage(msg: WSMessage): Promise<void> {
    if (msg.type === "file_changed") {
      const { file, deviceId } = msg as {
        type: string;
        file: string;
        fileVersion: number;
        globalVersion: number;
        deviceId: string;
      };

      if (deviceId === this.settings.deviceId) return;

      await this.pullFile(file);
    }
  }

  private async pullFile(path: string): Promise<void> {
    try {
      const indexResp = await this.apiCall("GET", "/sync/index");
      const fileEntry = indexResp.files.find(
        (f: { path: string }) => f.path === path,
      );
      if (!fileEntry) return;

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

      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, assembled.buffer);
      } else {
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
          await this.app.vault.createFolder(dir);
        }
        await this.app.vault.createBinary(path, assembled.buffer);
      }

      await this.localState.putFile({
        path,
        chunks: fileEntry.chunks,
        mtime: fileEntry.mtime,
        fileVersion: fileEntry.fileVersion,
        globalVersion: fileEntry.globalVersion,
      });
    } catch (e) {
      console.error(`Failed to pull ${path}:`, e);
    }
  }

  private async catchUp(): Promise<void> {
    try {
      const syncState = await this.localState.getSyncState();
      const resp = await this.apiCall(
        "GET",
        `/sync/changes?since=${syncState.globalVersion}`,
      );

      for (const change of resp.changes) {
        await this.pullFile(change.path);
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
        const file = this.app.vault.getAbstractFileByPath(op.path);
        if (file instanceof TFile) {
          await this.pushFile(file);
        }
        await this.localState.removePendingOp(op.opId);
      } catch (e) {
        console.error(`Pending op ${op.opId} failed:`, e);
      }
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
      headers: { Authorization: `Bearer ${this.settings.apiKey}` },
    });
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    return resp.arrayBuffer();
  }

  private async apiCall(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const url = `${this.settings.workerUrl}${path}`;
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`API ${path}: ${resp.status}`);
    return resp.json();
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
