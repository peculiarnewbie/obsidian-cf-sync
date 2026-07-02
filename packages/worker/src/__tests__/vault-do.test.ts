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
