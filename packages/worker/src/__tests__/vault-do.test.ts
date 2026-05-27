import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../worker";
import {
  ChangesResponse,
  ChunkUploadResponse,
  CommitResponse,
  FullIndexResponse,
  PrepareResponse,
  decodeUnknownSync,
} from "@obsidian-cf-sync/protocol";
import { SyncApi } from "@obsidian-cf-sync/protocol/http-api";

const API_KEY = "test-api-key";

function workerEnv() {
  return { ...env, SYNC_API_KEY: API_KEY };
}

function request(path: string, init: RequestInit = {}, vaultId = "http-vault") {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${API_KEY}`);
  headers.set("X-Vault-Id", vaultId);
  return new Request(`https://sync.test${path}`, { ...init, headers });
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("VaultDO", () => {
  it("full sync lifecycle", async () => {
    const stub = env.VaultDO.getByName("test-vault-lifecycle");

    // Register chunks
    const regResult = await stub.registerChunk({ hash: "chunk-aaa", size: 50 });
    expect(regResult.success).toBe(true);

    // Prepare
    const prepResult = await stub.prepare({
      opId: "op-lifecycle-1",
      action: "put",
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
      action: "put",
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
      action: "put",
      file: "notes/conflict.md",
      chunks: ["chunk-bbb"],
      mtime: 1000,
      size: 60,
      baseFileVersion: 0,
      deviceId: "device-1",
    });

    const result = await stub.prepare({
      opId: "op-conflict-2",
      action: "put",
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

    const result = await stub.commit({
      opId: "op-unknown-1",
      action: "put",
      file: "notes/test.md",
      chunks: ["nonexistent-hash"],
      mtime: 1000,
      size: 50,
      baseFileVersion: 0,
      deviceId: "device-1",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("CHUNK_NOT_REGISTERED");
  });

  it("supports empty files", async () => {
    const stub = env.VaultDO.getByName("test-vault-empty");

    const prepResult = await stub.prepare({
      opId: "op-empty-1",
      action: "put",
      file: "notes/empty.md",
      chunks: [],
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId: "device-1",
    });
    expect(prepResult.success).toBe(true);
    expect(prepResult.missing).toEqual([]);

    const commitResult = await stub.commit({
      opId: "op-empty-1",
      action: "put",
      file: "notes/empty.md",
      chunks: [],
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId: "device-1",
    });
    expect(commitResult.success).toBe(true);
  });

  it("commits delete tombstones", async () => {
    const stub = env.VaultDO.getByName("test-vault-delete");

    const result = await stub.commit({
      opId: "op-delete-1",
      action: "delete",
      file: "notes/deleted.md",
      chunks: [],
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId: "device-1",
    });
    expect(result.success).toBe(true);

    const changesResult = await stub.changes({ since: 0 });
    expect(changesResult.changes[0].action).toBe("delete");
  });
});

describe("Worker sync HTTP routes", () => {
  it("exposes the shared Effect HTTP API contract", () => {
    expect(Object.keys(SyncApi.groups.sync.endpoints).sort()).toEqual([
      "changes",
      "commit",
      "index",
      "prepare",
      "uploadChunk",
    ]);
  });

  it("rejects unauthenticated requests", async () => {
    const resp = await worker.fetch(
      new Request("https://sync.test/sync/index", {
        headers: { "X-Vault-Id": "http-auth-vault" },
      }),
      workerEnv(),
    );

    expect(resp.status).toBe(401);
  });

  it("uploads chunks and commits a file through HTTP", async () => {
    const vaultId = "http-lifecycle-vault";
    const data = new TextEncoder().encode("hello from http").buffer;
    const hash = await sha256Hex(data);

    const uploadResp = await worker.fetch(
      request(`/sync/chunk/${hash}`, { method: "PUT", body: data }, vaultId),
      workerEnv(),
    );
    expect(uploadResp.status).toBe(200);
    const upload = decodeUnknownSync(ChunkUploadResponse)(await uploadResp.json());
    expect(upload.hash).toBe(hash);

    const op = {
      opId: "http-op-1",
      action: "put",
      file: "notes/http.md",
      chunks: [hash],
      mtime: 1000,
      size: data.byteLength,
      baseFileVersion: 0,
      deviceId: "http-device-1",
    };

    const prepareResp = await worker.fetch(
      request(
        "/sync/prepare",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(op),
        },
        vaultId,
      ),
      workerEnv(),
    );
    expect(prepareResp.status).toBe(200);
    const prepare = decodeUnknownSync(PrepareResponse)(await prepareResp.json());
    expect(prepare.success).toBe(true);
    expect("missing" in prepare ? prepare.missing : []).toEqual([]);

    const commitResp = await worker.fetch(
      request(
        "/sync/commit",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(op),
        },
        vaultId,
      ),
      workerEnv(),
    );
    expect(commitResp.status).toBe(200);
    const commit = decodeUnknownSync(CommitResponse)(await commitResp.json());
    expect(commit.success).toBe(true);
    expect("globalVersion" in commit ? commit.globalVersion : 0).toBe(1);

    const changesResp = await worker.fetch(
      request("/sync/changes?since=0", { method: "GET" }, vaultId),
      workerEnv(),
    );
    const changes = decodeUnknownSync(ChangesResponse)(await changesResp.json());
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]?.path).toBe("notes/http.md");
  });

  it("isolates file indexes by vaultId", async () => {
    const op = {
      opId: "http-isolation-op-1",
      action: "put",
      file: "notes/isolated.md",
      chunks: [],
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId: "http-device-1",
    };

    const commitResp = await worker.fetch(
      request(
        "/sync/commit",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(op),
        },
        "http-vault-a",
      ),
      workerEnv(),
    );
    expect(decodeUnknownSync(CommitResponse)(await commitResp.json()).success).toBe(true);

    const vaultAResp = await worker.fetch(
      request("/sync/index", { method: "GET" }, "http-vault-a"),
      workerEnv(),
    );
    const vaultA = decodeUnknownSync(FullIndexResponse)(await vaultAResp.json());
    expect(vaultA.files.map((file) => file.path)).toContain("notes/isolated.md");

    const vaultBResp = await worker.fetch(
      request("/sync/index", { method: "GET" }, "http-vault-b"),
      workerEnv(),
    );
    const vaultB = decodeUnknownSync(FullIndexResponse)(await vaultBResp.json());
    expect(vaultB.files).toEqual([]);
  });
});
