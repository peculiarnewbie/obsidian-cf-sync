import { App, type EventRef, Notice, TFile } from "obsidian";
import type { PluginSettings } from "./settings";
import { LocalState, type PendingOp } from "./local-state";
import { ConnectionManager } from "./connection";
import {
  ChangesResponse as ChangesResponseSchema,
  CommitResponse as CommitResponseSchema,
  FullIndexResponse as FullIndexResponseSchema,
  FileStateResponse as FileStateResponseSchema,
  FilePath as FilePathSchema,
  PrepareResponse as PrepareResponseSchema,
  Schema,
  decodeUnknownSync,
} from "@obsidian-cf-sync/protocol";

const CHUNK_SIZE = 256 * 1024; // 256KB fixed-size chunks for v1
const CHANGE_PAGE_SIZE = 100;
const POLL_INTERVAL_MS = 60_000;

type EngineLifecycle = "stopped" | "starting" | "started";

type BootstrapResult =
  | { kind: "empty" }
  | { kind: "local-only"; localFiles: number }
  | { kind: "remote-only"; remoteFiles: number }
  | {
      kind: "both-populated";
      localOnlyPaths: number;
      remoteOnlyPaths: number;
      matchingPaths: number;
      conflictingPaths: number;
    };

export class SyncEngine {
  private app: App;
  private settings: PluginSettings;
  private localState: LocalState;
  private connection: ConnectionManager;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lifecycle: EngineLifecycle = "stopped";
  private startPromise: Promise<void> | null = null;
  private startGeneration = 0;
  private connectionHandlersInstalled = false;
  private syncPass: Promise<void> | null = null;
  private journalPass: Promise<void> = Promise.resolve();
  private syncRequested = false;
  private abortController: AbortController | null = null;
  private eventRefs: EventRef[] = [];
  private vaultReady = false;
  private applyingRemote = false;
  private scannedFiles = new Map<string, { mtime: number; size: number }>();
  private lastAuditAt = 0;

  constructor(app: App, settings: PluginSettings) {
    this.app = app;
    this.settings = { ...settings };
    this.localState = new LocalState({
      workerUrl: settings.workerUrl,
      vaultId: settings.vaultId,
      deviceId: settings.deviceId,
    });
    this.connection = new ConnectionManager(
      settings.workerUrl,
      settings.deviceToken,
      settings.vaultId,
      settings.deviceId,
    );
  }

  get active(): boolean {
    return this.lifecycle === "started";
  }

  /** Request a complete coordinator pass, including work already in progress. */
  syncNow(): Promise<void> {
    if (this.lifecycle === "stopped") return this.syncPass ?? Promise.resolve();
    return this.requestSync();
  }

  async start(): Promise<void> {
    if (this.lifecycle === "started") return;
    if (this.lifecycle === "starting" && this.startPromise) return this.startPromise;

    const generation = ++this.startGeneration;
    this.lifecycle = "starting";
    this.abortController = new AbortController();
    const startPromise = this.startInternal(this.abortController, generation);
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  stop(): void {
    if (this.lifecycle === "stopped") return;
    this.lifecycle = "stopped";
    this.startGeneration += 1;
    this.syncRequested = false;
    this.vaultReady = false;
    this.abortController?.abort();
    this.connection.disconnect();
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const eventRef of this.eventRefs) {
      this.app.vault.offref(eventRef);
    }
    this.eventRefs = [];
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.startPromise;
    await this.syncPass;
    await this.journalPass;
  }

  private async waitForLayout(signal: AbortSignal): Promise<void> {
    if (this.app.workspace.layoutReady || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
      this.app.workspace.onLayoutReady(done);
    });
  }

  private async startInternal(abortController: AbortController, generation: number): Promise<void> {
    await this.waitForLayout(abortController.signal);
    if (!this.isCurrentStart(abortController, generation)) return;
    await this.localState.init();
    if (!this.isCurrentStart(abortController, generation)) return;

    if (!(await this.localState.hasSyncState())) {
      let bootstrap: BootstrapResult;
      try {
        bootstrap = await this.bootstrapFreshScope();
      } catch (error) {
        if (!this.isCurrentStart(abortController, generation)) return;
        this.stopAfterFailedBootstrap("Unable to inspect the initial sync state", error);
        return;
      }
      if (bootstrap.kind === "both-populated") {
        this.stopAfterFailedBootstrap(
          `Initial sync paused: ${bootstrap.localOnlyPaths} local-only, ${bootstrap.remoteOnlyPaths} remote-only, and ${bootstrap.conflictingPaths} conflicting paths. Reconciliation UI is not implemented yet.`,
          bootstrap,
        );
        return;
      }
    }
    if (!this.isCurrentStart(abortController, generation)) return;

    if (!this.connectionHandlersInstalled) {
      this.connection.onMessage((message) => {
        if (message.type === "file_changed") void this.requestSync();
      });
      this.connection.onConnect(() => {
        void this.requestSync();
      });
      this.connectionHandlersInstalled = true;
    }
    this.lifecycle = "started";
    this.installVaultEventsWhenReady();
    this.connection.connect();
    this.startPolling();
  }

  private async bootstrapFreshScope(): Promise<BootstrapResult> {
    const localFiles = this.app.vault.getFiles().filter((file) => this.isSyncablePath(file.path));
    const savedBootstrap = await this.localState.getBootstrap();
    const remoteIndex =
      savedBootstrap ?? (await this.apiCall(FullIndexResponseSchema, "GET", "/sync/index"));

    for (const entry of remoteIndex.tombstones ?? []) {
      if (this.isSyncablePath(entry.path)) {
        await this.localState.putFile({ ...entry, chunks: [], deleted: true });
      }
    }

    if (localFiles.length === 0 && remoteIndex.files.length === 0) {
      await this.localState.updateSyncState({
        globalVersion: remoteIndex.globalVersion,
        lastFullSync: Date.now(),
      });
      return { kind: "empty" };
    }

    if (savedBootstrap || localFiles.length === 0) {
      if (!savedBootstrap) await this.localState.putBootstrap(remoteIndex);
      for (const fileEntry of [...remoteIndex.files].sort((a, b) => a.path.localeCompare(b.path))) {
        if (!this.isSyncablePath(fileEntry.path)) continue;
        const existing = this.app.vault.getAbstractFileByPath(fileEntry.path);
        if (
          savedBootstrap &&
          existing instanceof TFile &&
          !(await this.localState.getFile(fileEntry.path))
        ) {
          // Recover a crash between the filesystem write and its IndexedDB acknowledgement.
          const hashes = (await this.chunkData(await this.app.vault.readBinary(existing))).map(
            (chunk) => chunk.hash,
          );
          if (!this.arraysEqual(hashes, Array.from(fileEntry.chunks))) {
            throw new Error(
              `Untracked local content differs from the saved import: ${fileEntry.path}`,
            );
          }
          await this.localState.putFile({ ...fileEntry, chunks: hashes, deleted: false });
        }
        await this.applyFileEntry(fileEntry);
      }
      await this.localState.updateSyncState({
        globalVersion: remoteIndex.globalVersion,
        lastFullSync: Date.now(),
      });
      await this.localState.clearBootstrap();
      return { kind: "remote-only", remoteFiles: remoteIndex.files.length };
    }

    if (remoteIndex.files.length === 0) {
      await this.queueJournal(async () => {
        for (const file of localFiles) {
          await this.queuePut(file);
        }
      });
      await this.localState.updateSyncState({
        globalVersion: remoteIndex.globalVersion,
        lastFullSync: Date.now(),
      });
      return { kind: "local-only", localFiles: localFiles.length };
    }

    const remoteByPath = new Map<string, (typeof remoteIndex.files)[number]>(
      remoteIndex.files.map((file) => [file.path, file]),
    );
    let localOnlyPaths = 0;
    let matchingPaths = 0;
    let conflictingPaths = 0;
    for (const localFile of localFiles) {
      const remoteFile = remoteByPath.get(localFile.path);
      if (!remoteFile) {
        localOnlyPaths += 1;
        continue;
      }
      const localChunks = (await this.chunkData(await this.app.vault.readBinary(localFile))).map(
        (chunk) => chunk.hash,
      );
      if (this.arraysEqual(localChunks, Array.from(remoteFile.chunks))) {
        matchingPaths += 1;
      } else {
        conflictingPaths += 1;
      }
    }

    return {
      kind: "both-populated",
      localOnlyPaths,
      remoteOnlyPaths: remoteIndex.files.length - matchingPaths - conflictingPaths,
      matchingPaths,
      conflictingPaths,
    };
  }

  private stopAfterFailedBootstrap(message: string, details: unknown): void {
    this.lifecycle = "stopped";
    this.abortController?.abort();
    this.connection.disconnect();
    this.logError(message, details);
    new Notice(message);
  }

  private isCurrentStart(abortController: AbortController, generation: number): boolean {
    return (
      !abortController.signal.aborted &&
      this.abortController === abortController &&
      this.lifecycle === "starting" &&
      this.startGeneration === generation
    );
  }

  private installVaultEventsWhenReady(): void {
    const install = () => {
      if (this.lifecycle !== "started" || this.eventRefs.length > 0) return;
      this.eventRefs.push(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile) this.onFileChange(file);
        }),
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile) this.onFileChange(file);
        }),
        this.app.vault.on("delete", (file) => {
          if (file instanceof TFile) this.onFileDelete(file);
        }),
        this.app.vault.on("rename", (file, oldPath) => {
          if (file instanceof TFile) this.onFileRename(file, oldPath);
        }),
      );
      this.vaultReady = true;
      void this.requestSync();
    };

    if (this.app.workspace.layoutReady) {
      install();
    } else {
      this.app.workspace.onLayoutReady(install);
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.requestSync();
    }, POLL_INTERVAL_MS);
  }

  private onFileChange(file: TFile): void {
    if (this.lifecycle !== "started" || this.applyingRemote) return;
    if (this.isSyncablePath(file.path)) {
      void this.queueJournal(() => this.queuePut(file))
        .then(() => this.debounceSync())
        .catch((error: unknown) => this.logError("Queue put failed", error));
    }
  }

  private onFileDelete(file: TFile): void {
    if (this.lifecycle !== "started" || this.applyingRemote) return;
    if (this.isSyncablePath(file.path)) {
      void this.queueJournal(() => this.queueDelete(file.path))
        .then(() => this.debounceSync())
        .catch((error: unknown) => this.logError("Queue delete failed", error));
    }
  }

  private onFileRename(file: TFile, oldPath: string): void {
    if (this.lifecycle !== "started" || this.applyingRemote) return;
    const isNewPathSyncable = this.isSyncablePath(file.path);
    const isOldPathSyncable = this.isSyncablePath(oldPath);
    if (!isNewPathSyncable && !isOldPathSyncable) return;

    const work =
      isNewPathSyncable && isOldPathSyncable
        ? () => this.queueRename(file, oldPath)
        : isNewPathSyncable
          ? () => this.queuePut(file)
          : () => this.queueDelete(oldPath);
    void this.queueJournal(work)
      .then(() => this.debounceSync())
      .catch((error: unknown) => this.logError("Queue rename failed", error));
  }

  private queueJournal(work: () => Promise<void>): Promise<void> {
    const queued = this.journalPass.then(work);
    this.journalPass = queued.catch(() => undefined);
    return queued;
  }

  private async queuePut(file: TFile): Promise<void> {
    const observed = { path: file.path, mtime: file.stat.mtime, size: file.stat.size };
    const content = await this.app.vault.readBinary(file);
    const chunks = await this.chunkData(content);
    const chunkHashes = chunks.map((chunk) => chunk.hash);
    if (
      file.path === observed.path &&
      file.stat.mtime === observed.mtime &&
      file.stat.size === observed.size
    ) {
      this.scannedFiles.set(observed.path, observed);
    }
    const localEntry = await this.localState.getFile(file.path);
    const existingOp = await this.localState.getPendingOpAffectingPath(file.path);
    const hasSameSnapshot =
      (existingOp?.action === "put" || existingOp?.action === "rename") &&
      existingOp.path === file.path &&
      existingOp.mtime === file.stat.mtime &&
      existingOp.size === file.stat.size &&
      this.arraysEqual(existingOp.chunks, chunkHashes);

    if (hasSameSnapshot) return;
    if (localEntry && !existingOp && this.arraysEqual(localEntry.chunks, chunkHashes)) return;

    await this.cachePendingChunks(chunks);

    if (existingOp?.action === "rename" && !existingOp.attempted && existingOp.path === file.path) {
      await this.localState.replacePendingOp({
        ...existingOp,
        opId: crypto.randomUUID(),
        chunks: chunkHashes,
        mtime: file.stat.mtime,
        size: file.stat.size,
      });
      return;
    }

    await this.localState.replacePendingOp({
      opId: crypto.randomUUID(),
      action: "put",
      path: file.path,
      baseFileVersion:
        existingOp && existingOp.path === file.path
          ? this.pendingBaseVersion(existingOp, file.path)
          : (localEntry?.fileVersion ?? 0),
      chunks: chunkHashes,
      mtime: file.stat.mtime,
      size: file.stat.size,
      createdAt: Date.now(),
    });
  }

  private async queueRename(file: TFile, oldPath: string): Promise<void> {
    const content = await this.app.vault.readBinary(file);
    const chunks = await this.chunkData(content);
    const chunkHashes = chunks.map((chunk) => chunk.hash);
    const oldEntry = await this.localState.getFile(oldPath);
    const oldPendingOp = await this.localState.getPendingOpAffectingPath(oldPath);

    if (
      !oldEntry &&
      !oldPendingOp?.attempted &&
      oldPendingOp?.action === "put" &&
      oldPendingOp.path === oldPath
    ) {
      await this.localState.removePendingOp(oldPendingOp.opId);
      await this.queuePut(file);
      return;
    }

    await this.cachePendingChunks(chunks);

    if (
      !oldEntry &&
      !oldPendingOp?.attempted &&
      oldPendingOp?.action === "rename" &&
      oldPendingOp.path === oldPath
    ) {
      await this.localState.replacePendingOp({
        ...oldPendingOp,
        opId: crypto.randomUUID(),
        path: file.path,
        chunks: chunkHashes,
        mtime: file.stat.mtime,
        size: file.stat.size,
      });
      return;
    }

    const destinationEntry = await this.localState.getFile(file.path);
    await this.localState.replacePendingOp({
      opId: crypto.randomUUID(),
      action: "rename",
      path: file.path,
      oldPath,
      baseFileVersion: destinationEntry?.fileVersion ?? 0,
      oldBaseFileVersion: oldPendingOp?.attempted
        ? this.pendingBaseVersion(oldPendingOp, oldPath)
        : (oldEntry?.fileVersion ?? 0),
      chunks: chunkHashes,
      mtime: file.stat.mtime,
      size: file.stat.size,
      createdAt: Date.now(),
    });
  }

  private async queueDelete(path: string): Promise<void> {
    const localEntry = await this.localState.getFile(path);
    const existingOp = await this.localState.getPendingOpAffectingPath(path);

    if (
      !localEntry &&
      !existingOp?.attempted &&
      existingOp?.action === "put" &&
      existingOp.path === path
    ) {
      await this.localState.removePendingOp(existingOp.opId);
      return;
    }

    if (
      !localEntry &&
      !existingOp?.attempted &&
      existingOp?.action === "rename" &&
      existingOp.path === path
    ) {
      await this.localState.replacePendingOp({
        opId: crypto.randomUUID(),
        action: "delete",
        path: existingOp.oldPath ?? path,
        baseFileVersion: existingOp.oldBaseFileVersion ?? 0,
        chunks: [],
        mtime: Date.now(),
        size: 0,
        createdAt: Date.now(),
      });
      return;
    }

    if (!localEntry && !existingOp) return;

    await this.localState.replacePendingOp({
      opId: crypto.randomUUID(),
      action: "delete",
      path,
      baseFileVersion: existingOp?.attempted
        ? this.pendingBaseVersion(existingOp, path)
        : (localEntry?.fileVersion ?? existingOp?.baseFileVersion ?? 0),
      chunks: [],
      mtime: Date.now(),
      size: 0,
      createdAt: Date.now(),
    });
  }

  private pendingBaseVersion(op: PendingOp, path: string): number {
    const base = op.oldPath === path ? (op.oldBaseFileVersion ?? 0) : op.baseFileVersion;
    return base + (op.attempted ? 1 : 0);
  }

  private async cachePendingChunks(
    chunks: ReadonlyArray<{ hash: string; data: ArrayBuffer }>,
  ): Promise<void> {
    await Promise.all(
      chunks.map(async ({ hash, data }) => {
        await this.localState.putChunkData(hash, data);
      }),
    );
  }

  private debounceSync(): void {
    if (this.lifecycle !== "started") return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.requestSync();
    }, this.settings.syncInterval);
  }

  private requestSync(): Promise<void> {
    if (this.lifecycle !== "started" || !this.vaultReady || this.abortController?.signal.aborted) {
      return Promise.resolve();
    }
    this.syncRequested = true;
    if (this.syncPass) return this.syncPass;

    this.syncPass = this.runRequestedSyncPasses().finally(() => {
      this.syncPass = null;
      if (this.syncRequested && this.lifecycle === "started") {
        void this.requestSync();
      }
    });
    return this.syncPass;
  }

  private async runRequestedSyncPasses(): Promise<void> {
    while (this.syncRequested && this.lifecycle === "started") {
      this.syncRequested = false;
      await this.catchUp();
      if (this.lifecycle === "started") {
        await this.pushChanges();
      }
      if (this.lifecycle === "started") {
        await this.catchUp();
      }
    }
  }

  private async pushChanges(): Promise<void> {
    if (this.lifecycle !== "started") return;

    try {
      await this.reconcileLocalChanges();
      await this.syncPendingOps();
    } catch (e) {
      if (!this.abortController?.signal.aborted) {
        this.logError("Push failed", e);
      }
    }
  }

  private async reconcileLocalChanges(): Promise<void> {
    await this.queueJournal(async () => {
      const files = this.app.vault.getFiles().filter((file) => this.isSyncablePath(file.path));
      const currentPaths = new Set(files.map((file) => file.path));
      const audit = Date.now() - this.lastAuditAt >= 5 * 60_000;
      for (const file of files) {
        const scanned = this.scannedFiles.get(file.path);
        if (
          audit ||
          !scanned ||
          scanned.mtime !== file.stat.mtime ||
          scanned.size !== file.stat.size
        ) {
          await this.queuePut(file);
        }
      }
      if (audit) this.lastAuditAt = Date.now();
      for (const path of this.scannedFiles.keys()) {
        if (!currentPaths.has(path)) this.scannedFiles.delete(path);
      }

      const pendingOps = await this.localState.getPendingOps();
      for (const localEntry of await this.localState.getAllFiles()) {
        if (
          localEntry.deleted ||
          !this.isSyncablePath(localEntry.path) ||
          currentPaths.has(localEntry.path)
        ) {
          continue;
        }
        const pendingOp = pendingOps.findLast(
          (op) => op.path === localEntry.path || op.oldPath === localEntry.path,
        );
        if (pendingOp?.action === "rename" && pendingOp.oldPath === localEntry.path) continue;
        if (pendingOp?.action === "delete") continue;
        await this.queueDelete(localEntry.path);
      }
    });
  }

  private async commitPut(op: PendingOp): Promise<"committed" | "conflict"> {
    const body = {
      opId: op.opId,
      action: "put" as const,
      file: op.path,
      chunks: op.chunks,
      mtime: op.mtime,
      size: op.size,
      baseFileVersion: op.baseFileVersion,
      deviceId: this.settings.deviceId,
    };

    const prepareResp = await this.apiCall(PrepareResponseSchema, "POST", "/sync/prepare", body);

    if (!prepareResp.success) {
      new Notice(`Sync conflict on ${op.path}`);
      await this.createConflictCopy(op.path, await this.pendingContent(op));
      await this.pullFile(op.path);
      return "conflict";
    }

    if (!("alreadyCommitted" in prepareResp)) {
      for (const hash of prepareResp.missing ?? []) {
        const data = await this.localState.getChunkData(hash);
        if (!data) throw new Error(`Pending operation ${op.opId} is missing chunk ${hash}`);
        await this.uploadChunk(hash, data);
      }

      const commitResp = await this.apiCall(CommitResponseSchema, "POST", "/sync/commit", body);

      if (!commitResp.success) {
        new Notice(`Sync conflict on ${op.path}`);
        await this.createConflictCopy(op.path, await this.pendingContent(op));
        await this.pullFile(op.path);
        return "conflict";
      }

      if (commitResp.success) {
        await this.localState.putFile({
          path: op.path,
          chunks: op.chunks,
          mtime: op.mtime,
          fileVersion: commitResp.fileVersion,
          globalVersion: commitResp.globalVersion,
          deleted: false,
        });
      }
    } else {
      await this.localState.putFile({
        path: op.path,
        chunks: op.chunks,
        mtime: op.mtime,
        fileVersion: prepareResp.fileVersion,
        globalVersion: prepareResp.globalVersion,
        deleted: false,
      });
    }
    return "committed";
  }

  private async pullFile(path: string): Promise<void> {
    const response = await this.apiCall(
      FileStateResponseSchema,
      "GET",
      `/sync/file?${new URLSearchParams({ path })}`,
    );
    if (!response.file)
      throw new Error(`No canonical state returned for conflicting path: ${path}`);
    if (response.file.deleted) await this.applyDelete(response.file);
    else await this.applyFileEntry(response.file);
  }

  private async applyFileEntry(fileEntry: {
    path: string;
    opId?: string;
    chunks: readonly string[];
    mtime: number;
    fileVersion: number;
    globalVersion: number;
  }): Promise<void> {
    if (!this.isSyncablePath(fileEntry.path)) return;
    const known = await this.localState.getFile(fileEntry.path);
    if (known && known.globalVersion > fileEntry.globalVersion) return;
    if (
      fileEntry.opId &&
      (await this.localState.getPendingOps()).some(
        (op) => op.opId === fileEntry.opId && op.attempted,
      )
    ) {
      // A lost acknowledgement must not replay our snapshot over later local edits.
      await this.localState.putFile({
        ...fileEntry,
        chunks: Array.from(fileEntry.chunks),
        deleted: false,
      });
      return;
    }
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

    this.abortController?.signal.throwIfAborted();
    this.applyingRemote = true;
    try {
      const existing = this.app.vault.getAbstractFileByPath(fileEntry.path);
      if (existing instanceof TFile) {
        await this.preserveAndRecheckBeforeRemoteReplace(existing, fileEntry.path);
        if (this.app.vault.getAbstractFileByPath(fileEntry.path) !== existing) {
          throw new Error(`Local file changed while applying remote update: ${fileEntry.path}`);
        }
        this.abortController?.signal.throwIfAborted();
        await this.app.vault.modifyBinary(existing, assembled.buffer);
      } else {
        await this.ensureFolder(fileEntry.path);
        this.abortController?.signal.throwIfAborted();
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
      deleted: false,
    });
  }

  private async catchUp(): Promise<void> {
    try {
      const syncState = await this.localState.getSyncState();
      let cursor = syncState.globalVersion;
      let highWatermark: number | undefined;

      do {
        const query = new URLSearchParams({
          since: String(cursor),
          limit: String(CHANGE_PAGE_SIZE),
        });
        if (highWatermark !== undefined) query.set("through", String(highWatermark));

        const resp = await this.apiCall(
          ChangesResponseSchema,
          "GET",
          `/sync/changes?${query.toString()}`,
        );
        if (highWatermark === undefined) {
          highWatermark = resp.highWatermark;
        } else if (resp.highWatermark !== highWatermark) {
          throw new Error("Server changed the catch-up high-water mark");
        }

        for (const change of resp.changes) {
          if (change.globalVersion !== cursor + 1) {
            throw new Error(
              `Expected change ${cursor + 1}, received change ${change.globalVersion}`,
            );
          }
          if (change.action === "delete") {
            await this.applyDelete({
              opId: change.opId,
              path: change.path,
              mtime: change.mtime,
              fileVersion: change.fileVersion,
              globalVersion: change.globalVersion,
            });
          } else if (change.action === "rename") {
            await this.applyRename({
              opId: change.opId,
              path: change.path,
              oldPath: change.oldPath,
              oldFileVersion: change.oldFileVersion,
              chunks: Array.from(change.chunks),
              mtime: change.mtime,
              fileVersion: change.fileVersion,
              globalVersion: change.globalVersion,
            });
          } else {
            await this.applyFileEntry({
              opId: change.opId,
              path: change.path,
              chunks: Array.from(change.chunks),
              mtime: change.mtime,
              fileVersion: change.fileVersion,
              globalVersion: change.globalVersion,
            });
          }
          cursor = change.globalVersion;
          await this.localState.updateSyncState({
            globalVersion: cursor,
            lastFullSync: Date.now(),
          });
        }

        if (resp.nextCursor !== cursor) {
          throw new Error(`Server returned next cursor ${resp.nextCursor}, expected ${cursor}`);
        }
        if (!resp.hasMore) break;
      } while (this.lifecycle === "started");

      if (this.lifecycle === "started") {
        await this.localState.updateSyncState({
          globalVersion: cursor,
          lastFullSync: Date.now(),
        });
      }
    } catch (e) {
      if (!this.abortController?.signal.aborted) {
        this.logError("Catch-up sync failed", e);
      }
    }
  }

  private async syncPendingOps(): Promise<void> {
    const ops = await this.localState.getPendingOps();
    for (const pending of ops) {
      try {
        const op = await this.localState.beginPendingAttempt(pending.opId);
        if (!op) continue;
        if (op.action === "put") {
          await this.commitPut(op);
        } else if (op.action === "delete") {
          await this.commitDelete(op);
        } else {
          await this.commitRename(op);
        }
        await this.localState.removePendingOp(op.opId);
      } catch (e) {
        this.logError(`Pending operation ${pending.opId} will be retried`, e);
        break;
      }
    }
  }

  private async commitRename(op: PendingOp): Promise<void> {
    if (!op.oldPath) throw new Error(`Rename operation ${op.opId} is missing its source path`);

    const body = {
      opId: op.opId,
      action: "rename" as const,
      file: op.path,
      oldPath: op.oldPath,
      chunks: op.chunks,
      mtime: op.mtime,
      size: op.size,
      baseFileVersion: op.baseFileVersion,
      oldBaseFileVersion: op.oldBaseFileVersion ?? 0,
      deviceId: this.settings.deviceId,
    };
    const prepareResp = await this.apiCall(PrepareResponseSchema, "POST", "/sync/prepare", body);
    if (!prepareResp.success) {
      new Notice(`Sync conflict renaming ${op.oldPath}`);
      await this.createConflictCopy(op.path, await this.pendingContent(op));
      await this.pullFile(op.oldPath);
      return;
    }

    if (!("alreadyCommitted" in prepareResp)) {
      for (const hash of prepareResp.missing ?? []) {
        const data = await this.localState.getChunkData(hash);
        if (!data) throw new Error(`Pending operation ${op.opId} is missing chunk ${hash}`);
        await this.uploadChunk(hash, data);
      }
    }
    const commitResp =
      "alreadyCommitted" in prepareResp
        ? prepareResp
        : await this.apiCall(CommitResponseSchema, "POST", "/sync/commit", body);
    if (!commitResp.success) {
      new Notice(`Sync conflict renaming ${op.oldPath}`);
      await this.createConflictCopy(op.path, await this.pendingContent(op));
      await this.pullFile(op.oldPath);
      return;
    }
    await this.localState.putFile({
      path: op.path,
      chunks: op.chunks,
      mtime: op.mtime,
      fileVersion: commitResp.fileVersion,
      globalVersion: commitResp.globalVersion,
      deleted: false,
    });
    await this.localState.putFile({
      path: op.oldPath,
      chunks: [],
      mtime: op.mtime,
      fileVersion: (op.oldBaseFileVersion ?? 0) + 1,
      globalVersion: commitResp.globalVersion,
      deleted: true,
    });
  }

  private async commitDelete(op: PendingOp): Promise<"committed" | "conflict"> {
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
      return "conflict";
    }

    const commitResp =
      "alreadyCommitted" in prepareResp
        ? prepareResp
        : await this.apiCall(CommitResponseSchema, "POST", "/sync/commit", body);
    if (!commitResp.success) {
      new Notice(`Sync conflict deleting ${op.path}`);
      await this.pullFile(op.path);
      return "conflict";
    }
    if (commitResp.success) {
      await this.localState.putFile({
        path: op.path,
        chunks: [],
        mtime: op.mtime,
        fileVersion: commitResp.fileVersion,
        globalVersion: commitResp.globalVersion,
        deleted: true,
      });
    }
    return "committed";
  }

  private async applyRename(fileEntry: {
    path: string;
    opId?: string;
    oldPath: string | null;
    oldFileVersion: number | null;
    chunks: readonly string[];
    mtime: number;
    fileVersion: number;
    globalVersion: number;
  }): Promise<void> {
    if (!fileEntry.oldPath)
      throw new Error(`Rename change is missing its source path: ${fileEntry.path}`);
    if (fileEntry.oldFileVersion === null) {
      throw new Error(`Rename change is missing its source version: ${fileEntry.path}`);
    }
    await this.applyFileEntry(fileEntry);
    await this.applyDelete({
      opId: fileEntry.opId,
      path: fileEntry.oldPath,
      mtime: fileEntry.mtime,
      fileVersion: fileEntry.oldFileVersion,
      globalVersion: fileEntry.globalVersion,
    });
  }

  private async applyDelete(entry: {
    path: string;
    opId?: string;
    mtime: number;
    fileVersion: number;
    globalVersion: number;
  }): Promise<void> {
    if (!this.isSyncablePath(entry.path)) return;
    const known = await this.localState.getFile(entry.path);
    if (known && known.globalVersion > entry.globalVersion) return;
    if (
      entry.opId &&
      (await this.localState.getPendingOps()).some((op) => op.opId === entry.opId && op.attempted)
    ) {
      await this.localState.putFile({ ...entry, chunks: [], deleted: true });
      return;
    }
    this.abortController?.signal.throwIfAborted();
    this.applyingRemote = true;
    try {
      const existing = this.app.vault.getAbstractFileByPath(entry.path);
      if (existing instanceof TFile) {
        await this.preserveAndRecheckBeforeRemoteReplace(existing, entry.path);
        if (this.app.vault.getAbstractFileByPath(entry.path) !== existing) {
          throw new Error(`Local file changed while applying remote delete: ${entry.path}`);
        }
        this.abortController?.signal.throwIfAborted();
        await this.app.fileManager.trashFile(existing);
      }
      await this.localState.putFile({
        path: entry.path,
        chunks: [],
        mtime: entry.mtime,
        fileVersion: entry.fileVersion,
        globalVersion: entry.globalVersion,
        deleted: true,
      });
    } finally {
      this.applyingRemote = false;
    }
  }

  private async preserveAndRecheckBeforeRemoteReplace(file: TFile, path: string): Promise<void> {
    const localEntry = await this.localState.getFile(path);
    if (!localEntry) {
      throw new Error(`Refusing to overwrite untracked local file: ${path}`);
    }

    const currentContent = await this.app.vault.readBinary(file);
    const currentChunks = (await this.chunkData(currentContent)).map((chunk) => chunk.hash);
    if (!this.arraysEqual(localEntry.chunks, currentChunks)) {
      await this.createConflictCopy(path, currentContent);
    }

    const recheckedContent = await this.app.vault.readBinary(file);
    const recheckedChunks = (await this.chunkData(recheckedContent)).map((chunk) => chunk.hash);
    if (!this.arraysEqual(currentChunks, recheckedChunks)) {
      throw new Error(`Local file changed while preparing remote replacement: ${path}`);
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

  private async pendingContent(op: PendingOp): Promise<ArrayBuffer> {
    const chunks: ArrayBuffer[] = [];
    for (const hash of op.chunks) {
      const data = await this.localState.getChunkData(hash);
      if (!data) throw new Error(`Pending operation ${op.opId} is missing chunk ${hash}`);
      chunks.push(data);
    }

    const assembled = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      assembled.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return assembled.buffer;
  }

  private async uploadChunk(hash: string, data: ArrayBuffer): Promise<void> {
    const url = `${this.settings.workerUrl}/sync/chunk/${hash}`;
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.settings.deviceToken}`,
        "X-Vault-Id": this.settings.vaultId,
        "X-Device-Id": this.settings.deviceId,
        "Content-Type": "application/octet-stream",
      },
      body: data,
      signal: this.abortController?.signal,
    });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    await this.localState.putChunkData(hash, data);
  }

  private async downloadChunk(hash: string): Promise<ArrayBuffer> {
    const url = `${this.settings.workerUrl}/sync/chunk/${hash}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.settings.deviceToken}`,
        "X-Vault-Id": this.settings.vaultId,
        "X-Device-Id": this.settings.deviceId,
      },
      signal: this.abortController?.signal,
    });
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const data = await resp.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", data);
    const actual = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (actual !== hash) throw new Error(`Downloaded chunk hash mismatch: ${hash}`);
    return data;
  }

  private async apiCall<A>(
    schema: Schema.Decoder<A>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<A> {
    const url = `${this.settings.workerUrl}${path}`;
    const opts: RequestInit = {
      method,
      signal: this.abortController?.signal,
      headers: {
        Authorization: `Bearer ${this.settings.deviceToken}`,
        "X-Vault-Id": this.settings.vaultId,
        "X-Device-Id": this.settings.deviceId,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`API ${path}: ${resp.status}`);
    const payload: unknown = await resp.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "success" in payload &&
      payload.success === false &&
      "error" in payload &&
      typeof payload.error === "string"
    ) {
      throw new Error(`API ${path}: ${payload.error}`);
    }
    return decodeUnknownSync(schema)(payload);
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
    this.abortController?.signal.throwIfAborted();
    await this.app.vault.createBinary(candidate, content);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        this.abortController?.signal.throwIfAborted();
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

  private isSyncablePath(path: string): boolean {
    try {
      decodeUnknownSync(FilePathSchema)(path);
    } catch {
      return false;
    }
    const configDir = this.app.vault.configDir;
    return path !== configDir && !path.startsWith(`${configDir}/`);
  }

  private logError(message: string, error: unknown): void {
    console.error(`[Obsidian CF Sync] ${message}:`, error);
  }
}
