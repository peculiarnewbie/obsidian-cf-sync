import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../worker";
import {
  ChangesResponse,
  ChunkUploadResponse,
  CommitResponse,
  DeviceEnrollmentResponse,
  FullIndexResponse,
  PrepareResponse,
  decodeUnknownSync,
} from "@obsidian-cf-sync/protocol";
import { SyncApi } from "@obsidian-cf-sync/protocol/http-api";

const API_KEY = "test-api-key";

function workerEnv() {
  return { ...env, SYNC_API_KEY: API_KEY };
}

function request(
  path: string,
  init: RequestInit = {},
  vaultId = "http-vault",
  token = API_KEY,
  deviceId = "http-device-1",
) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-Vault-Id", vaultId);
  headers.set("X-Device-Id", deviceId);
  return new Request(`https://sync.test${path}`, { ...init, headers });
}

function bootstrapRequest(path: string, init: RequestInit = {}, vaultId = "http-vault") {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${API_KEY}`);
  headers.set("X-Vault-Id", vaultId);
  return new Request(`https://sync.test${path}`, { ...init, headers });
}

async function enrollDevice(vaultId: string, deviceId = "http-device-1"): Promise<string> {
  const resp = await worker.fetch(
    bootstrapRequest(
      "/devices/enroll",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, name: "Test Device", platform: "test" }),
      },
      vaultId,
    ),
    workerEnv(),
  );
  expect(resp.status).toBe(200);
  const enrollment = decodeUnknownSync(DeviceEnrollmentResponse)(await resp.json());
  expect(enrollment.deviceId).toBe(deviceId);
  return enrollment.deviceToken;
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
    expect(changesResult.nextCursor).toBe(1);
    expect(changesResult.highWatermark).toBe(1);
    expect(changesResult.hasMore).toBe(false);

    // Full index
    const indexResult = await stub.getFullIndex();
    expect(indexResult.files).toHaveLength(1);
    expect(indexResult.files[0].path).toBe("notes/test.md");
  });

  it("prepare requires the exact current file version", async () => {
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

    const futureVersion = await stub.prepare({
      opId: "op-conflict-future-version",
      action: "put",
      file: "notes/conflict.md",
      chunks: ["chunk-bbb"],
      mtime: 2000,
      size: 60,
      baseFileVersion: 2,
      deviceId: "device-2",
    });

    expect(futureVersion).toMatchObject({
      success: false,
      conflict: true,
      currentVersion: 1,
    });

    const futureCommit = await stub.commit({
      opId: "op-conflict-future-commit",
      action: "put",
      file: "notes/conflict.md",
      chunks: ["chunk-bbb"],
      mtime: 2000,
      size: 60,
      baseFileVersion: 2,
      deviceId: "device-2",
    });
    expect(futureCommit).toMatchObject({
      success: false,
      conflict: true,
      currentVersion: 1,
    });
    expect((await stub.changes({ since: 0 })).changes).toHaveLength(1);
  });

  it("renames atomically with one durable change entry", async () => {
    const stub = env.VaultDO.getByName("test-vault-atomic-rename");
    await stub.registerChunk({ hash: "chunk-rename", size: 42 });
    await stub.commit({
      opId: "rename-source-put",
      action: "put",
      file: "notes/old.md",
      chunks: ["chunk-rename"],
      mtime: 1000,
      size: 42,
      baseFileVersion: 0,
      deviceId: "device-1",
    });

    const result = await stub.commit({
      opId: "rename-atomic-op",
      action: "rename",
      file: "notes/new.md",
      oldPath: "notes/old.md",
      chunks: ["chunk-rename"],
      mtime: 2000,
      size: 42,
      baseFileVersion: 0,
      oldBaseFileVersion: 1,
      deviceId: "device-1",
    });
    expect(result).toMatchObject({ success: true, fileVersion: 1, globalVersion: 2 });

    const index = await stub.getFullIndex();
    expect(index).toMatchObject({ globalVersion: 2 });
    expect(index.files).toEqual([
      expect.objectContaining({
        path: "notes/new.md",
        fileVersion: 1,
        globalVersion: 2,
        chunks: ["chunk-rename"],
      }),
    ]);

    const changes = await stub.changes({ since: 1 });
    expect(changes.changes).toEqual([
      expect.objectContaining({
        globalVersion: 2,
        action: "rename",
        path: "notes/new.md",
        oldPath: "notes/old.md",
        oldFileVersion: 2,
        fileVersion: 1,
      }),
    ]);

    const retry = await stub.commit({
      opId: "rename-atomic-op",
      action: "rename",
      file: "notes/new.md",
      oldPath: "notes/old.md",
      chunks: ["chunk-rename"],
      mtime: 2000,
      size: 42,
      baseFileVersion: 0,
      oldBaseFileVersion: 1,
      deviceId: "device-1",
    });
    expect(retry).toMatchObject({
      success: true,
      alreadyCommitted: true,
      fileVersion: 1,
      globalVersion: 2,
    });
  });

  it("leaves both paths and the log untouched when a rename conflicts", async () => {
    const stub = env.VaultDO.getByName("test-vault-atomic-rename-conflict");
    await stub.commit({
      opId: "rename-conflict-source-put",
      action: "put",
      file: "notes/old.md",
      chunks: [],
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId: "device-1",
    });

    const result = await stub.commit({
      opId: "rename-conflict-op",
      action: "rename",
      file: "notes/new.md",
      oldPath: "notes/old.md",
      chunks: [],
      mtime: 2000,
      size: 0,
      baseFileVersion: 0,
      oldBaseFileVersion: 0,
      deviceId: "device-2",
    });
    expect(result).toMatchObject({ success: false, conflict: true, currentVersion: 1 });

    const index = await stub.getFullIndex();
    expect(index).toMatchObject({ globalVersion: 1 });
    expect(index.files).toEqual([expect.objectContaining({ path: "notes/old.md" })]);
    expect((await stub.changes({ since: 0 })).changes).toHaveLength(1);
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

  it("returns stable, bounded change pages", async () => {
    const stub = env.VaultDO.getByName("test-vault-change-pages");

    for (const suffix of ["one", "two", "three"]) {
      await stub.commit({
        opId: `page-${suffix}`,
        action: "delete",
        file: `notes/${suffix}.md`,
        chunks: [],
        mtime: 1000,
        size: 0,
        baseFileVersion: 0,
        deviceId: "device-1",
      });
    }

    const firstPage = await stub.changes({ since: 0, limit: 2 });
    expect(firstPage.changes.map((change) => change.globalVersion)).toEqual([1, 2]);
    expect(firstPage.nextCursor).toBe(2);
    expect(firstPage.highWatermark).toBe(3);
    expect(firstPage.hasMore).toBe(true);

    await stub.commit({
      opId: "page-four",
      action: "delete",
      file: "notes/four.md",
      chunks: [],
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId: "device-1",
    });

    const secondPage = await stub.changes({
      since: firstPage.nextCursor,
      through: firstPage.highWatermark,
      limit: 2,
    });
    expect(secondPage.changes.map((change) => change.globalVersion)).toEqual([3]);
    expect(secondPage.nextCursor).toBe(3);
    expect(secondPage.highWatermark).toBe(3);
    expect(secondPage.hasMore).toBe(false);

    const nextWindow = await stub.changes({ since: secondPage.nextCursor, limit: 2 });
    expect(nextWindow.changes.map((change) => change.globalVersion)).toEqual([4]);
    expect(nextWindow.highWatermark).toBe(4);
  });
});

describe("Worker sync HTTP routes", () => {
  it("exposes the shared Effect HTTP API contract", () => {
    expect(Object.keys(SyncApi.groups.sync.endpoints).sort()).toEqual([
      "changes",
      "commit",
      "enrollDevice",
      "index",
      "prepare",
      "revokeDevice",
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

  it("rejects sync requests from unenrolled devices", async () => {
    const resp = await worker.fetch(request("/sync/index", { method: "GET" }), workerEnv());

    expect(resp.status).toBe(401);
  });

  it("rejects an invalid change window", async () => {
    const vaultId = "http-invalid-change-window";
    const token = await enrollDevice(vaultId);

    const resp = await worker.fetch(
      request("/sync/changes?since=2&through=1", { method: "GET" }, vaultId, token),
      workerEnv(),
    );

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ code: "INVALID_CHANGE_WINDOW" });
  });

  it("rejects fractional change cursors", async () => {
    const vaultId = "http-fractional-change-cursor";
    const token = await enrollDevice(vaultId);

    const resp = await worker.fetch(
      request("/sync/changes?since=0.5", { method: "GET" }, vaultId, token),
      workerEnv(),
    );

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ code: "INVALID_CHANGE_QUERY" });
  });

  it("does not allow bootstrap tokens to authenticate sync routes", async () => {
    const vaultId = "http-bootstrap-not-sync-vault";
    await enrollDevice(vaultId);

    const resp = await worker.fetch(
      request("/sync/index", { method: "GET" }, vaultId, API_KEY),
      workerEnv(),
    );

    expect(resp.status).toBe(401);
  });

  it("rejects prepare and commit bodies for a different authenticated device", async () => {
    const vaultId = "http-device-mismatch-vault";
    const authenticatedDeviceId = "http-device-authenticated";
    const token = await enrollDevice(vaultId, authenticatedDeviceId);
    const mismatchedOp = {
      opId: "http-mismatch-op-1",
      action: "put",
      file: "notes/mismatch.md",
      chunks: [],
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId: "http-device-body",
    };

    const prepareResp = await worker.fetch(
      request(
        "/sync/prepare",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mismatchedOp),
        },
        vaultId,
        token,
        authenticatedDeviceId,
      ),
      workerEnv(),
    );
    expect(prepareResp.status).toBe(403);

    const commitResp = await worker.fetch(
      request(
        "/sync/commit",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mismatchedOp),
        },
        vaultId,
        token,
        authenticatedDeviceId,
      ),
      workerEnv(),
    );
    expect(commitResp.status).toBe(403);
  });

  it("rejects chunk uploads when the body hash does not match the route hash", async () => {
    const vaultId = "http-bad-chunk-vault";
    const deviceId = "http-device-bad-chunk";
    const token = await enrollDevice(vaultId, deviceId);
    const data = new TextEncoder().encode("actual chunk body").buffer;

    const resp = await worker.fetch(
      request(
        "/sync/chunk/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        { method: "PUT", body: data },
        vaultId,
        token,
        deviceId,
      ),
      workerEnv(),
    );

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ code: "HASH_MISMATCH" });
  });

  it("enforces chunk and manifest limits before mutating vault state", async () => {
    const vaultId = "http-limits-vault";
    const deviceId = "http-limits-device";
    const token = await enrollDevice(vaultId, deviceId);
    const oversizedChunk = new Uint8Array(512 * 1024 + 1).buffer;

    const chunkResp = await worker.fetch(
      request(
        `/sync/chunk/${"a".repeat(64)}`,
        { method: "PUT", body: oversizedChunk },
        vaultId,
        token,
        deviceId,
      ),
      workerEnv(),
    );
    expect(chunkResp.status).toBe(413);
    expect(await chunkResp.json()).toMatchObject({ code: "CHUNK_TOO_LARGE" });

    const batchedManifest = {
      opId: "http-batched-chunks",
      action: "put",
      file: "notes/batched.md",
      chunks: Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, "a")),
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId,
    };
    const batchedManifestResp = await worker.fetch(
      request(
        "/sync/prepare",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batchedManifest),
        },
        vaultId,
        token,
        deviceId,
      ),
      workerEnv(),
    );
    expect(batchedManifestResp.status).toBe(200);
    const batchedManifestResult = await batchedManifestResp.json();
    expect(batchedManifestResult).toMatchObject({ success: true });
    expect(batchedManifestResult.missing).toHaveLength(101);

    const tooManyChunks = {
      opId: "http-too-many-chunks",
      action: "put",
      file: "notes/too-many.md",
      chunks: Array.from({ length: 4097 }, () => "a".repeat(64)),
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId,
    };
    const manifestResp = await worker.fetch(
      request(
        "/sync/prepare",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tooManyChunks),
        },
        vaultId,
        token,
        deviceId,
      ),
      workerEnv(),
    );
    expect(manifestResp.status).toBe(400);
    expect(await manifestResp.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rotates a device token when a device is re-enrolled", async () => {
    const vaultId = "http-token-rotation-vault";
    const deviceId = "http-device-rotated";
    const oldToken = await enrollDevice(vaultId, deviceId);
    const newToken = await enrollDevice(vaultId, deviceId);

    expect(newToken).not.toBe(oldToken);

    const oldTokenResp = await worker.fetch(
      request("/sync/index", { method: "GET" }, vaultId, oldToken, deviceId),
      workerEnv(),
    );
    expect(oldTokenResp.status).toBe(401);

    const newTokenResp = await worker.fetch(
      request("/sync/index", { method: "GET" }, vaultId, newToken, deviceId),
      workerEnv(),
    );
    expect(newTokenResp.status).toBe(200);
  });

  it("enrolls and revokes devices", async () => {
    const vaultId = "http-revoke-vault";
    const deviceId = "http-device-revoked";
    const token = await enrollDevice(vaultId, deviceId);

    const indexResp = await worker.fetch(
      request("/sync/index", { method: "GET" }, vaultId, token, deviceId),
      workerEnv(),
    );
    expect(indexResp.status).toBe(200);

    const revokeResp = await worker.fetch(
      bootstrapRequest(
        "/devices/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId }),
        },
        vaultId,
      ),
      workerEnv(),
    );
    expect(revokeResp.status).toBe(200);

    const revokedIndexResp = await worker.fetch(
      request("/sync/index", { method: "GET" }, vaultId, token, deviceId),
      workerEnv(),
    );
    expect(revokedIndexResp.status).toBe(401);
  });

  it("uploads chunks and commits a file through HTTP", async () => {
    const vaultId = "http-lifecycle-vault";
    const deviceId = "http-device-1";
    const token = await enrollDevice(vaultId, deviceId);
    const data = new TextEncoder().encode("hello from http").buffer;
    const hash = await sha256Hex(data);

    const uploadResp = await worker.fetch(
      request(`/sync/chunk/${hash}`, { method: "PUT", body: data }, vaultId, token, deviceId),
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
      deviceId,
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
        token,
        deviceId,
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
        token,
        deviceId,
      ),
      workerEnv(),
    );
    expect(commitResp.status).toBe(200);
    const commit = decodeUnknownSync(CommitResponse)(await commitResp.json());
    expect(commit.success).toBe(true);
    expect("globalVersion" in commit ? commit.globalVersion : 0).toBe(1);

    const changesResp = await worker.fetch(
      request("/sync/changes?since=0", { method: "GET" }, vaultId, token, deviceId),
      workerEnv(),
    );
    const changes = decodeUnknownSync(ChangesResponse)(await changesResp.json());
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]?.path).toBe("notes/http.md");
  });

  it("only serves a chunk to devices whose vault registered it", async () => {
    const vaultA = "http-chunk-auth-vault-a";
    const vaultB = "http-chunk-auth-vault-b";
    const deviceA = "http-chunk-auth-device-a";
    const deviceB = "http-chunk-auth-device-b";
    const tokenA = await enrollDevice(vaultA, deviceA);
    const tokenB = await enrollDevice(vaultB, deviceB);
    const data = new TextEncoder().encode("vault-scoped chunk").buffer;
    const hash = await sha256Hex(data);

    const upload = await worker.fetch(
      request(`/sync/chunk/${hash}`, { method: "PUT", body: data }, vaultA, tokenA, deviceA),
      workerEnv(),
    );
    expect(upload.status).toBe(200);

    const ownerDownload = await worker.fetch(
      request(`/sync/chunk/${hash}`, { method: "GET" }, vaultA, tokenA, deviceA),
      workerEnv(),
    );
    expect(ownerDownload.status).toBe(200);
    expect(await ownerDownload.arrayBuffer()).toEqual(data);

    const otherVaultDownload = await worker.fetch(
      request(`/sync/chunk/${hash}`, { method: "GET" }, vaultB, tokenB, deviceB),
      workerEnv(),
    );
    expect(otherVaultDownload.status).toBe(404);
  });

  it("isolates file indexes by vaultId", async () => {
    const tokenA = await enrollDevice("http-vault-a");
    const tokenB = await enrollDevice("http-vault-b");
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
        tokenA,
      ),
      workerEnv(),
    );
    expect(decodeUnknownSync(CommitResponse)(await commitResp.json()).success).toBe(true);

    const vaultAResp = await worker.fetch(
      request("/sync/index", { method: "GET" }, "http-vault-a", tokenA),
      workerEnv(),
    );
    const vaultA = decodeUnknownSync(FullIndexResponse)(await vaultAResp.json());
    expect(vaultA.files.map((file) => file.path)).toContain("notes/isolated.md");

    const vaultBResp = await worker.fetch(
      request("/sync/index", { method: "GET" }, "http-vault-b", tokenB),
      workerEnv(),
    );
    const vaultB = decodeUnknownSync(FullIndexResponse)(await vaultBResp.json());
    expect(vaultB.files).toEqual([]);
  });

  it("syncs changes between two enrolled devices and blocks revoked devices", async () => {
    const vaultId = "http-two-device-vault";
    const deviceA = "device-a";
    const deviceB = "device-b";
    const tokenA = await enrollDevice(vaultId, deviceA);
    const tokenB = await enrollDevice(vaultId, deviceB);

    const commitA = {
      opId: "two-device-a-create",
      action: "put",
      file: "notes/shared.md",
      chunks: [],
      mtime: 1000,
      size: 0,
      baseFileVersion: 0,
      deviceId: deviceA,
    };

    const commitAResp = await worker.fetch(
      request(
        "/sync/commit",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(commitA),
        },
        vaultId,
        tokenA,
        deviceA,
      ),
      workerEnv(),
    );
    const resultA = decodeUnknownSync(CommitResponse)(await commitAResp.json());
    expect(resultA.success).toBe(true);
    expect("globalVersion" in resultA ? resultA.globalVersion : 0).toBe(1);

    const changesForBResp = await worker.fetch(
      request("/sync/changes?since=0", { method: "GET" }, vaultId, tokenB, deviceB),
      workerEnv(),
    );
    const changesForB = decodeUnknownSync(ChangesResponse)(await changesForBResp.json());
    expect(changesForB.changes).toHaveLength(1);
    expect(changesForB.changes[0]?.path).toBe("notes/shared.md");
    expect(changesForB.changes[0]?.deviceId).toBe(deviceA);

    const commitB = {
      opId: "two-device-b-delete",
      action: "delete",
      file: "notes/shared.md",
      chunks: [],
      mtime: 2000,
      size: 0,
      baseFileVersion: 1,
      deviceId: deviceB,
    };

    const commitBResp = await worker.fetch(
      request(
        "/sync/commit",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(commitB),
        },
        vaultId,
        tokenB,
        deviceB,
      ),
      workerEnv(),
    );
    const resultB = decodeUnknownSync(CommitResponse)(await commitBResp.json());
    expect(resultB.success).toBe(true);
    expect("globalVersion" in resultB ? resultB.globalVersion : 0).toBe(2);

    const changesForAResp = await worker.fetch(
      request("/sync/changes?since=1", { method: "GET" }, vaultId, tokenA, deviceA),
      workerEnv(),
    );
    const changesForA = decodeUnknownSync(ChangesResponse)(await changesForAResp.json());
    expect(changesForA.changes).toHaveLength(1);
    expect(changesForA.changes[0]?.action).toBe("delete");
    expect(changesForA.changes[0]?.deviceId).toBe(deviceB);

    const indexResp = await worker.fetch(
      request("/sync/index", { method: "GET" }, vaultId, tokenA, deviceA),
      workerEnv(),
    );
    const index = decodeUnknownSync(FullIndexResponse)(await indexResp.json());
    expect(index.files).toEqual([]);

    const revokeResp = await worker.fetch(
      bootstrapRequest(
        "/devices/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId: deviceB }),
        },
        vaultId,
      ),
      workerEnv(),
    );
    expect(revokeResp.status).toBe(200);

    const revokedResp = await worker.fetch(
      request("/sync/changes?since=0", { method: "GET" }, vaultId, tokenB, deviceB),
      workerEnv(),
    );
    expect(revokedResp.status).toBe(401);
  });
});
