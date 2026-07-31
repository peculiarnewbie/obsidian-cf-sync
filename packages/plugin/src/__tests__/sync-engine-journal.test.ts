import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import type { LocalState, PendingOp } from "../local-state";
import type { PluginSettings } from "../settings";
import { SyncEngine } from "../sync-engine";

class TestFile extends TFile {
  content: ArrayBuffer;

  constructor(path: string, content: ArrayBuffer) {
    super();
    this.path = path;
    this.content = content;
    this.stat = { ctime: 0, mtime: 1000, size: content.byteLength };
  }
}

interface SyncEngineHarness {
  localState: LocalState;
  applyDelete(entry: {
    path: string;
    mtime: number;
    fileVersion: number;
    globalVersion: number;
  }): Promise<void>;
  applyFileEntry(file: {
    path: string;
    chunks: readonly string[];
    mtime: number;
    fileVersion: number;
    globalVersion: number;
  }): Promise<void>;
  bootstrapFreshScope(): Promise<{ kind: string }>;
  queuePut(file: TFile): Promise<void>;
  syncPendingOps(): Promise<void>;
}

const settings: PluginSettings = {
  workerUrl: "https://sync.example.com",
  apiKey: "",
  vaultId: "journal-test",
  deviceId: "journal-device",
  deviceToken: "device-token",
  syncInterval: 500,
  enabled: true,
};

function makeApp(files: TestFile[]): App {
  const folders = new Set<string>();
  return {
    vault: {
      configDir: ".obsidian",
      getFiles: () => files,
      readBinary: async (file: TFile) => (file as TestFile).content.slice(0),
      getAbstractFileByPath: (path: string) =>
        files.find((file) => file.path === path) ?? (folders.has(path) ? { path } : null),
      createBinary: async (path: string, content: ArrayBuffer) => {
        files.push(new TestFile(path, content));
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      modifyBinary: async (file: TFile, content: ArrayBuffer) => {
        (file as TestFile).content = content;
      },
    },
    fileManager: {
      trashFile: async (file: TFile) => {
        const index = files.indexOf(file as TestFile);
        if (index >= 0) files.splice(index, 1);
      },
    },
  } as unknown as App;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SyncEngine outgoing journal", () => {
  it("retries a put from its IndexedDB snapshot after the live file is gone", async () => {
    const bytes = new TextEncoder().encode("durable pending content").buffer;
    const files = [new TestFile("notes/journal.md", bytes)];
    const engine = new SyncEngine(makeApp(files), {
      ...settings,
      deviceId: `journal-device-${crypto.randomUUID()}`,
    });
    const harness = engine as unknown as SyncEngineHarness;
    await harness.localState.init();
    await harness.queuePut(files[0]!);

    const [pending] = await harness.localState.getPendingOps();
    expect(pending).toMatchObject({ action: "put", path: "notes/journal.md" });
    expect(pending?.chunks).toHaveLength(1);

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    files.length = 0;
    await harness.syncPendingOps();
    expect(await harness.localState.getPendingOps()).toHaveLength(1);

    const op = pending as PendingOp;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const path = String(url);
        if (path.endsWith("/sync/prepare")) {
          return Response.json({ success: true, missing: op.chunks, currentVersion: 0 });
        }
        if (path.includes("/sync/chunk/")) {
          return Response.json({ success: true, hash: op.chunks[0] });
        }
        if (path.endsWith("/sync/commit")) {
          return Response.json({ success: true, fileVersion: 1, globalVersion: 1 });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    await harness.syncPendingOps();

    expect(await harness.localState.getPendingOps()).toEqual([]);
    expect(await harness.localState.getFile("notes/journal.md")).toMatchObject({
      chunks: op.chunks,
      fileVersion: 1,
      globalVersion: 1,
    });
  });

  it("keeps a remote deletion tombstone so a later recreation uses the exact version", async () => {
    const files: TestFile[] = [];
    const engine = new SyncEngine(makeApp(files), {
      ...settings,
      deviceId: `recreate-after-delete-${crypto.randomUUID()}`,
    });
    const harness = engine as unknown as SyncEngineHarness;
    await harness.localState.init();

    await harness.applyDelete({
      path: "notes/recreated.md",
      mtime: 1000,
      fileVersion: 4,
      globalVersion: 8,
    });
    expect(await harness.localState.getFile("notes/recreated.md")).toMatchObject({
      fileVersion: 4,
      globalVersion: 8,
      deleted: true,
    });

    const recreated = new TestFile(
      "notes/recreated.md",
      new TextEncoder().encode("created again").buffer,
    );
    files.push(recreated);
    await harness.queuePut(recreated);

    expect(await harness.localState.getPendingOps()).toEqual([
      expect.objectContaining({
        action: "put",
        path: "notes/recreated.md",
        baseFileVersion: 4,
      }),
    ]);
  });
});

describe("SyncEngine initial reconciliation", () => {
  it("records an empty initial scope without creating operations", async () => {
    const engine = new SyncEngine(makeApp([]), {
      ...settings,
      deviceId: `empty-bootstrap-${crypto.randomUUID()}`,
    });
    const harness = engine as unknown as SyncEngineHarness;
    await harness.localState.init();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ files: [], globalVersion: 0 })),
    );

    await expect(harness.bootstrapFreshScope()).resolves.toEqual({ kind: "empty" });
    expect(await harness.localState.hasSyncState()).toBe(true);
    expect(await harness.localState.getPendingOps()).toEqual([]);
  });

  it("imports a remote-only vault without treating it as a local conflict", async () => {
    const files: TestFile[] = [];
    const engine = new SyncEngine(makeApp(files), {
      ...settings,
      deviceId: `remote-bootstrap-${crypto.randomUUID()}`,
    });
    const harness = engine as unknown as SyncEngineHarness;
    await harness.localState.init();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          files: [
            {
              path: "remote.md",
              chunks: [],
              mtime: 1,
              size: 0,
              fileVersion: 1,
              globalVersion: 1,
            },
          ],
          globalVersion: 1,
        }),
      ),
    );

    await expect(harness.bootstrapFreshScope()).resolves.toMatchObject({
      kind: "remote-only",
      remoteFiles: 1,
    });
    expect(files.map((file) => file.path)).toEqual(["remote.md"]);
    expect(await harness.localState.getSyncState()).toMatchObject({ globalVersion: 1 });
  });

  it("journals a local-only vault before marking initial state", async () => {
    const files = [new TestFile("local.md", new TextEncoder().encode("local").buffer)];
    const engine = new SyncEngine(makeApp(files), {
      ...settings,
      deviceId: `local-bootstrap-${crypto.randomUUID()}`,
    });
    const harness = engine as unknown as SyncEngineHarness;
    await harness.localState.init();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ files: [], globalVersion: 0 })),
    );

    await expect(harness.bootstrapFreshScope()).resolves.toMatchObject({
      kind: "local-only",
      localFiles: 1,
    });
    expect(await harness.localState.getPendingOps()).toEqual([
      expect.objectContaining({ action: "put", path: "local.md" }),
    ]);
    expect(await harness.localState.hasSyncState()).toBe(true);
  });

  it("pauses a both-populated vault without changing either side", async () => {
    const files = [new TestFile("shared.md", new TextEncoder().encode("local").buffer)];
    const engine = new SyncEngine(makeApp(files), {
      ...settings,
      deviceId: `both-bootstrap-${crypto.randomUUID()}`,
    });
    const harness = engine as unknown as SyncEngineHarness;
    await harness.localState.init();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          files: [
            {
              path: "shared.md",
              chunks: ["f".repeat(64)],
              mtime: 1,
              size: 1,
              fileVersion: 1,
              globalVersion: 1,
            },
          ],
          globalVersion: 1,
        }),
      ),
    );

    await expect(harness.bootstrapFreshScope()).resolves.toMatchObject({
      kind: "both-populated",
      conflictingPaths: 1,
    });
    expect(await harness.localState.hasSyncState()).toBe(false);
    expect(await harness.localState.getPendingOps()).toEqual([]);
    expect(files.map((file) => file.path)).toEqual(["shared.md"]);
  });

  it("refuses to overwrite an untracked local file during remote application", async () => {
    const localContent = new TextEncoder().encode("do not overwrite").buffer;
    const files = [new TestFile("unknown.md", localContent)];
    const engine = new SyncEngine(makeApp(files), {
      ...settings,
      deviceId: `untracked-file-${crypto.randomUUID()}`,
    });
    const harness = engine as unknown as SyncEngineHarness;
    await harness.localState.init();

    await expect(
      harness.applyFileEntry({
        path: "unknown.md",
        chunks: [],
        mtime: 1,
        fileVersion: 1,
        globalVersion: 1,
      }),
    ).rejects.toThrow("Refusing to overwrite untracked local file");
    expect(new TextDecoder().decode(files[0]!.content)).toBe("do not overwrite");
  });
});
