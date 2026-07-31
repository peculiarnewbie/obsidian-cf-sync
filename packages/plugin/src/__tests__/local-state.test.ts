import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { LocalState, localStateDatabaseName } from "../local-state";

const baseScope = {
  workerUrl: "https://sync.example.com/",
  vaultId: "personal",
  deviceId: "desktop-a",
};

describe("localStateDatabaseName", () => {
  it("normalizes harmless URL differences for the same sync identity", () => {
    expect(localStateDatabaseName(baseScope)).toBe(
      localStateDatabaseName({ ...baseScope, workerUrl: "https://sync.example.com/#ignored" }),
    );
  });

  it("isolates state for each Worker, vault, and device", () => {
    const databaseName = localStateDatabaseName(baseScope);

    expect(localStateDatabaseName({ ...baseScope, vaultId: "work" })).not.toBe(databaseName);
    expect(localStateDatabaseName({ ...baseScope, deviceId: "mobile-b" })).not.toBe(databaseName);
    expect(
      localStateDatabaseName({ ...baseScope, workerUrl: "https://other-sync.example.com" }),
    ).not.toBe(databaseName);
  });

  it("rejects an invalid Worker URL before opening storage", () => {
    expect(() => localStateDatabaseName({ ...baseScope, workerUrl: "not a URL" })).toThrow();
  });
});

describe("LocalState pending operations", () => {
  it("persists chunk snapshots and atomically replaces operations for affected paths", async () => {
    const scope = { ...baseScope, deviceId: `journal-${crypto.randomUUID()}` };
    const state = new LocalState(scope);
    await state.init();

    const chunk = new TextEncoder().encode("snapshot before a network retry").buffer;
    await state.putChunkData("chunk-a", chunk);
    await state.replacePendingOp({
      opId: "put-new-path",
      action: "put",
      path: "notes/renamed.md",
      baseFileVersion: 0,
      chunks: ["chunk-a"],
      mtime: 1000,
      size: chunk.byteLength,
      createdAt: 1000,
    });
    await state.replacePendingOp({
      opId: "rename-old-to-new",
      action: "rename",
      path: "notes/renamed.md",
      oldPath: "notes/original.md",
      baseFileVersion: 0,
      oldBaseFileVersion: 4,
      chunks: ["chunk-a"],
      mtime: 1001,
      size: chunk.byteLength,
      createdAt: 1001,
    });

    const reopened = new LocalState(scope);
    await reopened.init();

    expect(await reopened.getPendingOps()).toEqual([
      expect.objectContaining({
        opId: "rename-old-to-new",
        action: "rename",
        oldPath: "notes/original.md",
      }),
    ]);
    expect(await reopened.getPendingOpAffectingPath("notes/original.md")).toEqual(
      expect.objectContaining({ opId: "rename-old-to-new" }),
    );
    expect(new Uint8Array((await reopened.getChunkData("chunk-a")) ?? [])).toEqual(
      new Uint8Array(chunk),
    );
  });
});
