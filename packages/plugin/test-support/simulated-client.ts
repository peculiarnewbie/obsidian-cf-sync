import "fake-indexeddb/auto";
import { App, TFile } from "obsidian";
import { SyncEngine } from "../src/sync-engine";
import { LocalState } from "../src/local-state";
import type { PluginSettings } from "../src/settings";

class MemoryFile extends TFile {
  constructor(
    path: string,
    public content: ArrayBuffer,
  ) {
    super();
    this.path = path;
    this.stat = { ctime: 1, mtime: 1, size: content.byteLength };
  }
}

type Listener = { event: string; callback: (file: TFile, oldPath: string) => void };

/** Only the Obsidian host is simulated; file events enter the real coordinator. */
export class SimulatedClient {
  readonly files = new Map<string, MemoryFile>();
  readonly folders = new Set<string>();
  readonly state: LocalState;
  engine: SyncEngine;
  private listeners = new Set<Listener>();
  private readonly app: App;

  constructor(readonly settings: PluginSettings) {
    this.state = new LocalState(settings);
    this.app = {
      workspace: { layoutReady: true },
      vault: {
        configDir: ".obsidian",
        getFiles: () => [...this.files.values()],
        getAbstractFileByPath: (path: string) =>
          this.files.get(path) ?? (this.folders.has(path) ? { path } : null),
        readBinary: async (file: MemoryFile) => file.content.slice(0),
        createBinary: async (path: string, bytes: ArrayBuffer) => this.create(path, bytes),
        modifyBinary: async (file: MemoryFile, bytes: ArrayBuffer) => this.modify(file, bytes),
        createFolder: async (path: string) => {
          this.folders.add(path);
        },
        on: (event: string, callback: Listener["callback"]) => {
          const listener = { event, callback };
          this.listeners.add(listener);
          return listener;
        },
        offref: (listener: Listener) => this.listeners.delete(listener),
      },
      fileManager: { trashFile: async (file: MemoryFile) => this.remove(file.path) },
    } as unknown as App;
    this.engine = new SyncEngine(this.app, settings);
  }

  async start() {
    await this.state.init();
    await this.engine.start();
    await this.engine.syncNow();
  }

  async restart() {
    await this.stop();
    this.engine = new SyncEngine(this.app, this.settings);
    await this.start();
  }

  async stop() {
    this.engine.stop();
    // Drain an existing coordinator before discarding the host instance.
    await this.engine.syncNow();
  }

  sync() {
    return this.engine.syncNow();
  }

  write(path: string, text: string) {
    const bytes = new Uint8Array(new TextEncoder().encode(text)).buffer;
    const file = this.files.get(path);
    if (file) this.modify(file, bytes);
    else this.create(path, bytes);
  }

  rename(oldPath: string, path: string) {
    const file = this.requiredFile(oldPath);
    if (this.files.has(path)) throw new Error(`Destination exists: ${path}`);
    this.files.delete(oldPath);
    file.path = path;
    this.files.set(path, file);
    this.emit("rename", file, oldPath);
  }

  remove(path: string) {
    const file = this.requiredFile(path);
    this.files.delete(path);
    this.emit("delete", file);
  }

  snapshot() {
    return Object.fromEntries(
      [...this.files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, file]) => [path, new TextDecoder().decode(file.content)]),
    );
  }

  private requiredFile(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing file: ${path}`);
    return file;
  }

  private create(path: string, bytes: ArrayBuffer) {
    if (this.files.has(path)) throw new Error(`File exists: ${path}`);
    const file = new MemoryFile(path, bytes.slice(0));
    this.files.set(path, file);
    this.emit("create", file);
    return file;
  }

  private modify(file: MemoryFile, bytes: ArrayBuffer) {
    file.content = bytes.slice(0);
    file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: bytes.byteLength };
    this.emit("modify", file);
  }

  private emit(event: string, file: TFile, oldPath = "") {
    for (const listener of this.listeners) {
      if (listener.event === event) listener.callback(file, oldPath);
    }
  }
}
