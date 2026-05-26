import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("VaultDO", () => {
  it("full sync lifecycle", async () => {
    const stub = env.VaultDO.getByName("test-vault-lifecycle");

    // Register chunks
    const regResult = await stub.registerChunk({ hash: "chunk-aaa", size: 50 });
    expect(regResult.success).toBe(true);

    // Prepare
    const prepResult = await stub.prepare({
      opId: "op-lifecycle-1",
      file: "notes/test.md",
      chunks: ["chunk-aaa"],
      mtime: 1000,
      size: 50,
      baseFileVersion: 0,
      deviceId: "device-1",
    });
    expect(prepResult.success).toBe(true);
    expect(prepResult.missing).toEqual([]);

    // Commit
    const commitResult = await stub.commit({
      opId: "op-lifecycle-1",
      file: "notes/test.md",
      chunks: ["chunk-aaa"],
      mtime: 1000,
      size: 50,
      baseFileVersion: 0,
      deviceId: "device-1",
    });
    expect(commitResult.success).toBe(true);
    expect(commitResult.fileVersion).toBe(1);
    expect(commitResult.globalVersion).toBe(1);

    // Changes since 0
    const changesResult = await stub.changes({ since: 0 });
    expect(changesResult.changes).toHaveLength(1);
    expect(changesResult.globalVersion).toBe(1);

    // Full index
    const indexResult = await stub.getFullIndex();
    expect(indexResult.files).toHaveLength(1);
    expect(indexResult.files[0].path).toBe("notes/test.md");
  });

  it("prepare detects conflict", async () => {
    const stub = env.VaultDO.getByName("test-vault-conflict");

    await stub.registerChunk({ hash: "chunk-bbb", size: 60 });
    await stub.commit({
      opId: "op-conflict-1",
      file: "notes/conflict.md",
      chunks: ["chunk-bbb"],
      mtime: 1000,
      size: 60,
      baseFileVersion: 0,
      deviceId: "device-1",
    });

    const result = await stub.prepare({
      opId: "op-conflict-2",
      file: "notes/conflict.md",
      chunks: ["chunk-bbb"],
      mtime: 2000,
      size: 60,
      baseFileVersion: 0,
      deviceId: "device-2",
    });

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.currentVersion).toBe(1);
  });

  it("commit rejects unknown chunks", async () => {
    const stub = env.VaultDO.getByName("test-vault-unknown");

    await expect(
      stub.commit({
        opId: "op-unknown-1",
        file: "notes/test.md",
        chunks: ["nonexistent-hash"],
        mtime: 1000,
        size: 50,
        baseFileVersion: 0,
        deviceId: "device-1",
      }),
    ).rejects.toThrow("not registered");
  });
});
