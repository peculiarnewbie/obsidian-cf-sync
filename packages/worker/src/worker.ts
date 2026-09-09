import { dashboardResponse } from "./dashboard";
import { DurableObject } from "cloudflare:workers";
import {
  DeviceProgressRequest as DeviceProgressRequestSchema,
  type DeviceProgressRequest,
  ChunkHash as ChunkHashSchema,
  FilePath as FilePathSchema,
  type FilePath,
  ChangesQuery as ChangesQuerySchema,
  CommitRequest as CommitRequestSchema,
  DeviceEnrollmentRequest as DeviceEnrollmentRequestSchema,
  PrepareRequest as PrepareRequestSchema,
  RevokeDeviceRequest as RevokeDeviceRequestSchema,
  VaultId as VaultIdSchema,
  decodeUnknownSync,
  type CommitRequest,
  type ChangesQuery,
  type DeviceEnrollmentRequest,
  type PrepareRequest,
  type RevokeDeviceRequest,
  type VaultId,
} from "@obsidian-cf-sync/protocol";

export interface Env {
  CHUNKS_BUCKET: R2Bucket;
  SYNC_API_KEY: string | { get(): string };
  VaultDO: DurableObjectNamespace<VaultDO>;
}

interface RpcContext {
  vaultId: VaultId;
  deviceId?: string;
}

const MAX_CHUNK_BYTES = 512 * 1024;
const MAX_SQL_BOUND_PARAMETERS = 100;

// JSON error response helper
function errorResponse(
  e: { error: string; code?: string; details?: Record<string, unknown> },
  status = 400,
): Response {
  return Response.json(e, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await routeRequest(request, env);
    } catch (error) {
      response = handleRouteError(error);
    }
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  },
};

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if ((url.pathname === "/" || url.pathname === "/dashboard") && request.method === "GET")
    return dashboardResponse();

  const context = getRpcContext(request);
  if (!context.ok) return errorResponse({ error: context.error, code: "INVALID_VAULT_ID" });

  if (url.pathname === "/devices/enroll" && request.method === "POST") {
    if (!checkBootstrapAuth(request, env)) return new Response("Unauthorized", { status: 401 });
    const validated = decodeRequest(DeviceEnrollmentRequestSchema, await readJson(request));
    if (!validated.ok) return errorResponse(validated);
    return await handleEnrollDevice(env, context.data, validated.data);
  }

  if (url.pathname === "/devices/revoke" && request.method === "POST") {
    if (!checkBootstrapAuth(request, env)) return new Response("Unauthorized", { status: 401 });
    const validated = decodeRequest(RevokeDeviceRequestSchema, await readJson(request));
    if (!validated.ok) return errorResponse(validated);
    return await handleRevokeDevice(env, context.data, validated.data);
  }

  if (url.pathname === "/admin/dashboard" && request.method === "GET") {
    if (url.searchParams.has("token") || !checkBootstrapAuth(request, env))
      return new Response("Unauthorized", { status: 401 });
    return Response.json(await env.VaultDO.getByName(context.data.vaultId).dashboard(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const deviceAuth = await getDeviceAuthContext(request, env, context.data);
  if (!deviceAuth.ok) return new Response("Unauthorized", { status: 401 });
  const authenticatedContext = deviceAuth.data;

  if (url.pathname === "/sync/status" && request.method === "POST") {
    const progress = decodeRequest(DeviceProgressRequestSchema, await readJson(request));
    if (!progress.ok) return errorResponse(progress);
    const result = await env.VaultDO.getByName(context.data.vaultId).reportProgress({
      ...progress.data,
      deviceId: authenticatedContext.deviceId!,
    });
    return Response.json(result, { status: result.success ? 200 : 400 });
  }

  if (url.pathname.startsWith("/sync/ws")) {
    return handleWebSocket(request, env, authenticatedContext);
  }

  try {
    if (url.pathname === "/sync/chunk/:hash") {
      return await handleChunkUpload(request, env, authenticatedContext);
    }
    const path = url.pathname;
    if (path.startsWith("/sync/chunk/") && request.method === "PUT") {
      return await handleChunkUpload(request, env, authenticatedContext);
    }
    if (path === "/sync/prepare" && request.method === "POST") {
      const validated = decodeRequest(PrepareRequestSchema, await readJson(request));
      if (!validated.ok) return errorResponse(validated);
      if (validated.data.deviceId !== authenticatedContext.deviceId) {
        return errorResponse(
          { error: "deviceId does not match authenticated device", code: "DEVICE_MISMATCH" },
          403,
        );
      }
      return await handleRpc(env, authenticatedContext, "prepare", validated.data);
    }
    if (path === "/sync/commit" && request.method === "POST") {
      const validated = decodeRequest(CommitRequestSchema, await readJson(request));
      if (!validated.ok) return errorResponse(validated);
      if (validated.data.deviceId !== authenticatedContext.deviceId) {
        return errorResponse(
          { error: "deviceId does not match authenticated device", code: "DEVICE_MISMATCH" },
          403,
        );
      }
      return await handleRpc(env, authenticatedContext, "commit", validated.data);
    }
    if (path === "/sync/changes" && request.method === "GET") {
      const query = decodeRequest(ChangesQuerySchema, {
        since: url.searchParams.get("since") ?? "0",
        ...(url.searchParams.has("through") ? { through: url.searchParams.get("through") } : {}),
        ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {}),
      });
      if (!query.ok) {
        return errorResponse({ error: query.error, code: "INVALID_CHANGE_QUERY" });
      }
      if (!isValidChangesQuery(query.data)) {
        return errorResponse({
          error: "since, through, and limit must be safe integers within their allowed ranges",
          code: "INVALID_CHANGE_QUERY",
        });
      }
      if (query.data.through !== undefined && query.data.through < query.data.since) {
        return errorResponse({
          error: "through must be greater than or equal to since",
          code: "INVALID_CHANGE_WINDOW",
        });
      }
      return await handleRpc(env, authenticatedContext, "changes", query.data);
    }
    if (path === "/sync/file" && request.method === "GET") {
      const filePath = decodeRequest(FilePathSchema, url.searchParams.get("path"));
      if (!filePath.ok) return errorResponse(filePath);
      return Response.json(
        await env.VaultDO.getByName(authenticatedContext.vaultId).getFileState({
          path: filePath.data,
        }),
      );
    }
    if (path === "/sync/index" && request.method === "GET") {
      return await handleRpc(env, authenticatedContext, "getFullIndex", undefined);
    }
    if (path.startsWith("/sync/chunk/") && request.method === "GET") {
      return await handleChunkDownload(request, env, authenticatedContext);
    }

    return new Response("Not found", { status: 404 });
  } catch (e) {
    return handleRouteError(e);
  }
}

function checkBootstrapAuth(request: Request, env: Env): boolean {
  const expected = typeof env.SYNC_API_KEY === "string" ? env.SYNC_API_KEY : env.SYNC_API_KEY.get();
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (token) return token === expected;

  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === expected;
}

async function getDeviceAuthContext(
  request: Request,
  env: Env,
  context: RpcContext,
): Promise<{ ok: true; data: RpcContext & { deviceId: string } } | { ok: false }> {
  const url = new URL(request.url);
  const deviceId = request.headers.get("X-Device-Id") ?? url.searchParams.get("deviceId");
  const token = bearerToken(request) ?? url.searchParams.get("token");
  if (!deviceId || !token) return { ok: false };

  const stub = env.VaultDO.getByName(context.vaultId) as unknown as VaultDOStub;
  const valid = await stub.validateDevice({ deviceId, tokenHash: await sha256Hex(token) });
  if (!valid.valid) return { ok: false };
  return { ok: true, data: { ...context, deviceId } };
}

function bearerToken(request: Request): string | undefined {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return undefined;
  return auth.slice(7);
}

function getRpcContext(
  request: Request,
): { ok: true; data: RpcContext } | { ok: false; error: string } {
  const url = new URL(request.url);
  const rawVaultId = request.headers.get("X-Vault-Id") ?? url.searchParams.get("vaultId");
  try {
    const vaultId = decodeUnknownSync(VaultIdSchema)(rawVaultId);
    return { ok: true, data: { vaultId } };
  } catch {
    return {
      ok: false,
      error: "vaultId is required and may only contain letters, numbers, underscores, and dashes",
    };
  }
}

function decodeRequest<T>(
  schema: { readonly Type: T },
  value: unknown,
): { ok: true; data: T } | { ok: false; error: string; code: string } {
  try {
    return { ok: true, data: decodeUnknownSync(schema as never)(value) as T };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Invalid request body",
      code: "INVALID_REQUEST",
    };
  }
}

function isValidChangesQuery({ since, through, limit = 100 }: ChangesQuery): boolean {
  return (
    Number.isSafeInteger(since) &&
    since >= 0 &&
    (through === undefined || (Number.isSafeInteger(through) && through >= 0)) &&
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= 100
  );
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Vault-Id, X-Device-Id",
  };
}

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readLimitedBody(
  request: Request,
  limit: number,
  code = "BODY_TOO_LARGE",
): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RequestFailure(413, code, `Request exceeds ${limit} byte limit`);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result.buffer;
}

async function readJson(request: Request): Promise<unknown> {
  const body = await readLimitedBody(request, 512 * 1024);
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RequestFailure(400, "INVALID_JSON", "Malformed JSON request");
  }
}

function handleRouteError(e: unknown): Response {
  if (e instanceof RequestFailure)
    return errorResponse({ error: e.message, code: e.code }, e.status);
  if (e instanceof Error) {
    return Response.json({ error: e.message, code: "INTERNAL_ERROR" }, { status: 500 });
  }
  return Response.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
}

type RpcBody = PrepareRequest | CommitRequest | ChangesQuery | undefined;

type VaultDOStub = {
  prepare(body: PrepareRequest): Promise<unknown>;
  commit(body: CommitRequest): Promise<unknown>;
  changes(body: ChangesQuery): Promise<unknown>;
  getFullIndex(): Promise<unknown>;
  registerChunk(body: { hash: string; size: number }): Promise<{ success: true }>;
  enrollDevice(
    body: DeviceEnrollmentRequest & { tokenHash: string },
  ): Promise<{ success: true; deviceId: string }>;
  revokeDevice(body: RevokeDeviceRequest): Promise<{ success: true; deviceId: string }>;
  validateDevice(body: { deviceId: string; tokenHash: string }): Promise<{ valid: boolean }>;
  hasChunk(body: { hash: string }): Promise<{ exists: boolean }>;
  fetch(request: Request): Promise<Response>;
};

async function handleEnrollDevice(
  env: Env,
  context: RpcContext,
  body: DeviceEnrollmentRequest,
): Promise<Response> {
  const deviceToken = generateToken();
  const tokenHash = await sha256Hex(deviceToken);
  const stub = env.VaultDO.getByName(context.vaultId) as unknown as VaultDOStub;
  await stub.enrollDevice({ ...body, tokenHash });
  return Response.json({ success: true, deviceId: body.deviceId, deviceToken });
}

async function handleRevokeDevice(
  env: Env,
  context: RpcContext,
  body: RevokeDeviceRequest,
): Promise<Response> {
  const stub = env.VaultDO.getByName(context.vaultId) as unknown as VaultDOStub;
  const result = await stub.revokeDevice(body);
  return Response.json(result);
}

async function handleRpc(
  env: Env,
  context: RpcContext,
  method: string,
  body: RpcBody,
): Promise<Response> {
  const stub = env.VaultDO.getByName(context.vaultId) as unknown as VaultDOStub;
  if (method === "changes") {
    const result = await stub.changes((body as ChangesQuery | undefined) ?? { since: 0 });
    return Response.json(result);
  }
  if (method === "getFullIndex") {
    const result = await stub.getFullIndex();
    return Response.json(result);
  }
  if (method === "prepare") {
    const result = await stub.prepare(body as PrepareRequest);
    return Response.json(result);
  }
  if (method === "commit") {
    const result = await stub.commit(body as CommitRequest);
    return Response.json(result);
  }
  throw new Error(`Unknown RPC method: ${method}`);
}

async function handleWebSocket(request: Request, env: Env, context: RpcContext): Promise<Response> {
  const stub = env.VaultDO.getByName(context.vaultId) as unknown as VaultDOStub;
  return stub.fetch(request);
}

async function handleChunkUpload(
  request: Request,
  env: Env,
  context: RpcContext,
): Promise<Response> {
  const url = new URL(request.url);
  const rawHash = url.pathname.split("/").pop();
  if (!rawHash) return new Response("Missing hash", { status: 400 });
  const hash = decodeRequest(ChunkHashSchema, rawHash);
  if (!hash.ok) return errorResponse(hash);

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredSize = Number(contentLength);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      return errorResponse({ error: "Invalid Content-Length", code: "INVALID_CONTENT_LENGTH" });
    }
    if (declaredSize > MAX_CHUNK_BYTES) {
      return errorResponse({ error: "Chunk exceeds 512 KiB limit", code: "CHUNK_TOO_LARGE" }, 413);
    }
  }

  const body = await readLimitedBody(request, MAX_CHUNK_BYTES, "CHUNK_TOO_LARGE");
  if (body.byteLength > MAX_CHUNK_BYTES) {
    return errorResponse({ error: "Chunk exceeds 512 KiB limit", code: "CHUNK_TOO_LARGE" }, 413);
  }
  const digest = await crypto.subtle.digest("SHA-256", body);
  const computedHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (computedHash !== hash.data) {
    return errorResponse({ error: "Hash mismatch", code: "HASH_MISMATCH" });
  }

  await env.CHUNKS_BUCKET.put(`chunks/${hash.data}`, body);

  const stub = env.VaultDO.getByName(context.vaultId) as unknown as VaultDOStub;
  await stub.registerChunk({ hash: hash.data, size: body.byteLength });

  return Response.json({ success: true, hash: hash.data });
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function handleChunkDownload(
  request: Request,
  env: Env,
  context: RpcContext,
): Promise<Response> {
  const url = new URL(request.url);
  const rawHash = url.pathname.split("/").pop();
  if (!rawHash) return new Response("Missing hash", { status: 400 });
  const hash = decodeRequest(ChunkHashSchema, rawHash);
  if (!hash.ok) return errorResponse(hash);

  const stub = env.VaultDO.getByName(context.vaultId) as unknown as VaultDOStub;
  if (!(await stub.hasChunk({ hash: hash.data })).exists) {
    return new Response("Not found", { status: 404 });
  }

  const obj = await env.CHUNKS_BUCKET.get(`chunks/${hash.data}`);
  if (!obj) return new Response("Not found", { status: 404 });

  return new Response(obj.body, {
    headers: { "Content-Type": "application/octet-stream" },
  });
}

export class VaultDO extends DurableObject<Env> {
  private sql!: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong" }),
      ),
    );
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        chunks_json TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        file_version INTEGER NOT NULL,
        global_version INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        last_device_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS changes (
        global_version INTEGER PRIMARY KEY,
        op_id TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        old_path TEXT,
        old_file_version INTEGER,
        action TEXT NOT NULL,
        file_version INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        chunks_json TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        last_sync_version INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        token_hash TEXT,
        enrolled_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS chunks (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        ref_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conflicts (
        conflict_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        winning_global_version INTEGER NOT NULL,
        losing_device_id TEXT NOT NULL,
        losing_chunks_json TEXT NOT NULL,
        losing_mtime INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS vault_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing("devices", "token_hash", "TEXT");
    this.addColumnIfMissing("devices", "enrolled_at", "INTEGER");
    this.addColumnIfMissing("devices", "reported_at", "INTEGER");
    this.addColumnIfMissing("devices", "pending_operations", "INTEGER");
    this.addColumnIfMissing("devices", "sync_state", "TEXT");
    this.addColumnIfMissing("changes", "old_file_version", "INTEGER");
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    try {
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.toLowerCase().includes("duplicate column")) {
        throw e;
      }
    }
  }

  private queryOne(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    const rows = this.sql.exec(sql, ...params).toArray();
    return rows.length > 0 ? rows[0] : undefined;
  }

  async registerChunk(body: { hash: string; size: number }): Promise<{ success: true }> {
    const { hash, size } = body;
    const existing = this.queryOne("SELECT hash FROM chunks WHERE hash = ?", hash);
    if (!existing) {
      this.sql.exec(
        "INSERT INTO chunks (hash, size, ref_count, first_seen_at) VALUES (?, ?, 0, ?)",
        hash,
        size,
        Date.now(),
      );
    }
    return { success: true };
  }

  async hasChunk(body: { hash: string }): Promise<{ exists: boolean }> {
    return {
      exists: this.queryOne("SELECT hash FROM chunks WHERE hash = ?", body.hash) !== undefined,
    };
  }

  async enrollDevice(
    body: DeviceEnrollmentRequest & { tokenHash: string },
  ): Promise<{ success: true; deviceId: string }> {
    const now = Date.now();
    this.closeDeviceSockets(body.deviceId);
    this.sql.exec(
      `INSERT OR REPLACE INTO devices
       (device_id, name, platform, last_seen, last_sync_version, revoked, token_hash, enrolled_at)
       VALUES (?, ?, ?, ?, COALESCE((SELECT last_sync_version FROM devices WHERE device_id = ?), 0), 0, ?, ?)`,
      body.deviceId,
      body.name,
      body.platform,
      now,
      body.deviceId,
      body.tokenHash,
      now,
    );
    return { success: true, deviceId: body.deviceId };
  }

  async revokeDevice(body: RevokeDeviceRequest): Promise<{ success: true; deviceId: string }> {
    this.sql.exec("UPDATE devices SET revoked = 1 WHERE device_id = ?", body.deviceId);
    this.closeDeviceSockets(body.deviceId);
    return { success: true, deviceId: body.deviceId };
  }

  async validateDevice(body: { deviceId: string; tokenHash: string }): Promise<{ valid: boolean }> {
    const device = this.queryOne(
      "SELECT token_hash, revoked FROM devices WHERE device_id = ?",
      body.deviceId,
    );
    const valid =
      device !== undefined &&
      Number(device.revoked) === 0 &&
      typeof device.token_hash === "string" &&
      device.token_hash === body.tokenHash;

    if (valid) {
      this.sql.exec(
        "UPDATE devices SET last_seen = ? WHERE device_id = ?",
        Date.now(),
        body.deviceId,
      );
    }

    return { valid };
  }

  async reportProgress(body: DeviceProgressRequest & { deviceId: string }) {
    if (body.globalVersion > this.getGlobalVersion()) {
      return {
        success: false,
        code: "FUTURE_CURSOR",
        error: "Reported cursor exceeds the vault version",
      };
    }
    this.sql.exec(
      `UPDATE devices SET last_sync_version = ?, pending_operations = ?, sync_state = ?, reported_at = ?
      WHERE device_id = ? AND revoked = 0`,
      body.globalVersion,
      body.pendingOperations,
      body.state,
      Date.now(),
      body.deviceId,
    );
    return { success: true };
  }

  async dashboard() {
    const files = this.queryOne(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files WHERE deleted = 0",
    )!;
    const devices = this.sql
      .exec(
        "SELECT device_id, name, platform, enrolled_at, last_seen, revoked, reported_at, last_sync_version, pending_operations, sync_state FROM devices ORDER BY last_seen DESC, device_id LIMIT 200",
      )
      .toArray();
    return {
      globalVersion: this.getGlobalVersion(),
      fileCount: Number(files.count),
      fileBytes: Number(files.bytes),
      registeredChunkBytes: Number(
        this.queryOne("SELECT COALESCE(SUM(size), 0) AS bytes FROM chunks")!.bytes,
      ),
      deviceCount: Number(this.queryOne("SELECT COUNT(*) AS count FROM devices")!.count),
      unresolvedConflictCount: Number(
        this.queryOne("SELECT COUNT(*) AS count FROM conflicts WHERE resolved = 0")!.count,
      ),
      devices: devices.map((row) => ({
        deviceId: String(row.device_id),
        name: String(row.name),
        platform: String(row.platform),
        enrolledAt: row.enrolled_at == null ? null : Number(row.enrolled_at),
        lastSeen: Number(row.last_seen),
        revoked: Number(row.revoked) !== 0,
        connected: this.ctx.getWebSockets(String(row.device_id)).length > 0,
        reportedAt: row.reported_at == null ? null : Number(row.reported_at),
        reportedVersion: row.reported_at == null ? null : Number(row.last_sync_version),
        pendingOperations: row.pending_operations == null ? null : Number(row.pending_operations),
        state: row.sync_state == null ? null : String(row.sync_state),
      })),
      conflicts: this.sql
        .exec(
          "SELECT conflict_id, path, losing_device_id, created_at FROM conflicts WHERE resolved = 0 ORDER BY created_at DESC LIMIT 50",
        )
        .toArray()
        .map((row) => ({
          id: String(row.conflict_id),
          path: String(row.path),
          deviceId: String(row.losing_device_id),
          createdAt: Number(row.created_at),
        })),
    };
  }

  async prepare(body: PrepareRequest) {
    const { file, chunks, baseFileVersion } = body;

    const existingOp = this.committedOperation(body);
    if (existingOp) return existingOp;

    const current = this.queryOne(
      "SELECT file_version, chunks_json, deleted FROM files WHERE path = ?",
      file,
    );
    const currentVersion = Number(current?.file_version ?? 0);

    if (currentVersion !== baseFileVersion) {
      return {
        success: false,
        conflict: true,
        currentVersion,
        currentChunks: current ? (JSON.parse(String(current.chunks_json)) as string[]) : [],
      };
    }

    if (body.action === "rename") {
      if (current && Number(current.deleted) === 0) {
        return {
          success: false,
          conflict: true,
          currentVersion,
          currentChunks: JSON.parse(String(current.chunks_json)) as string[],
        };
      }
      const source = this.queryOne(
        "SELECT file_version, chunks_json, deleted FROM files WHERE path = ?",
        body.oldPath,
      );
      const sourceVersion = Number(source?.file_version ?? 0);
      if (
        body.oldPath === body.file ||
        source === undefined ||
        Number(source.deleted) !== 0 ||
        sourceVersion !== body.oldBaseFileVersion
      ) {
        return {
          success: false,
          conflict: true,
          currentVersion: sourceVersion,
          currentChunks: source ? (JSON.parse(String(source.chunks_json)) as string[]) : [],
        };
      }
    }

    return {
      success: true,
      missing: body.action === "delete" ? [] : this.missingChunks(chunks),
      currentVersion,
    };
  }

  async commit(body: CommitRequest) {
    const result = this.ctx.storage.transactionSync(() => this.commitTransaction(body));
    if (result.success && !("alreadyCommitted" in result)) {
      this.broadcast({
        type: "file_changed",
        action: body.action,
        file: body.file,
        oldPath: body.action === "rename" ? body.oldPath : null,
        fileVersion: result.fileVersion,
        globalVersion: result.globalVersion,
        deviceId: body.deviceId,
      });
    }
    return result;
  }

  private committedOperation(body: CommitRequest) {
    const existing = this.queryOne("SELECT * FROM changes WHERE op_id = ?", body.opId);
    if (!existing) return undefined;
    const matches =
      existing.path === body.file &&
      existing.action === body.action &&
      existing.device_id === body.deviceId &&
      Number(existing.mtime) === body.mtime &&
      Number(existing.size) === body.size &&
      existing.chunks_json === JSON.stringify(body.chunks) &&
      Number(existing.file_version) === body.baseFileVersion + 1 &&
      (body.action !== "rename" ||
        (existing.old_path === body.oldPath &&
          Number(existing.old_file_version) === body.oldBaseFileVersion + 1));
    if (!matches) {
      return {
        success: false as const,
        error: "Operation ID was already used for a different payload",
        code: "OP_ID_REUSED",
      };
    }
    return {
      success: true as const,
      alreadyCommitted: true as const,
      fileVersion: Number(existing.file_version),
      globalVersion: Number(existing.global_version),
    };
  }

  private commitTransaction(body: CommitRequest) {
    const existingOp = this.committedOperation(body);
    if (existingOp) return existingOp;

    const current = this.queryOne(
      "SELECT file_version, global_version, chunks_json, deleted FROM files WHERE path = ?",
      body.file,
    );
    const currentVersion = Number(current?.file_version ?? 0);
    if (currentVersion !== body.baseFileVersion) {
      return this.recordConflict(body, current, currentVersion);
    }

    if (body.action === "rename") {
      return this.commitRenameTransaction(body, current, currentVersion);
    }

    if (body.action === "put") {
      const missingChunk = findMissingChunk(this.sql, body.chunks);
      if (missingChunk) {
        return {
          success: false as const,
          error: `Chunk ${missingChunk} not registered. Upload it first.`,
          code: "CHUNK_NOT_REGISTERED",
        };
      }
    }

    const nextGlobalVersion = this.nextGlobalVersion();
    const nextFileVersion = currentVersion + 1;
    const now = Date.now();
    const chunksJson = JSON.stringify(body.chunks);
    if (body.action === "delete") {
      this.writeFile({
        path: body.file,
        chunksJson: "[]",
        mtime: body.mtime,
        size: 0,
        fileVersion: nextFileVersion,
        globalVersion: nextGlobalVersion,
        deleted: true,
        deviceId: body.deviceId,
        now,
      });
    } else {
      this.writeFile({
        path: body.file,
        chunksJson,
        mtime: body.mtime,
        size: body.size,
        fileVersion: nextFileVersion,
        globalVersion: nextGlobalVersion,
        deleted: false,
        deviceId: body.deviceId,
        now,
      });
    }
    this.writeChange({
      globalVersion: nextGlobalVersion,
      opId: body.opId,
      path: body.file,
      oldPath: null,
      oldFileVersion: null,
      action: body.action,
      fileVersion: nextFileVersion,
      deviceId: body.deviceId,
      chunksJson: body.action === "delete" ? "[]" : chunksJson,
      mtime: body.mtime,
      size: body.action === "delete" ? 0 : body.size,
      now,
    });
    this.setGlobalVersion(nextGlobalVersion);

    return {
      success: true as const,
      fileVersion: nextFileVersion,
      globalVersion: nextGlobalVersion,
    };
  }

  private commitRenameTransaction(
    body: Extract<CommitRequest, { action: "rename" }>,
    destination: Record<string, unknown> | undefined,
    destinationVersion: number,
  ) {
    const source = this.queryOne(
      "SELECT file_version, global_version, chunks_json, deleted FROM files WHERE path = ?",
      body.oldPath,
    );
    const sourceVersion = Number(source?.file_version ?? 0);
    if (
      body.oldPath === body.file ||
      source === undefined ||
      Number(source.deleted) !== 0 ||
      sourceVersion !== body.oldBaseFileVersion
    ) {
      return this.recordConflict(body, source, sourceVersion);
    }
    if (destination && Number(destination.deleted) === 0) {
      return this.recordConflict(body, destination, destinationVersion);
    }

    const missingChunk = findMissingChunk(this.sql, body.chunks);
    if (missingChunk) {
      return {
        success: false as const,
        error: `Chunk ${missingChunk} not registered. Upload it first.`,
        code: "CHUNK_NOT_REGISTERED",
      };
    }

    const nextGlobalVersion = this.nextGlobalVersion();
    const destinationFileVersion = destinationVersion + 1;
    const sourceFileVersion = sourceVersion + 1;
    const now = Date.now();
    const chunksJson = JSON.stringify(body.chunks);
    this.writeFile({
      path: body.file,
      chunksJson,
      mtime: body.mtime,
      size: body.size,
      fileVersion: destinationFileVersion,
      globalVersion: nextGlobalVersion,
      deleted: false,
      deviceId: body.deviceId,
      now,
    });
    this.writeFile({
      path: body.oldPath,
      chunksJson: "[]",
      mtime: body.mtime,
      size: 0,
      fileVersion: sourceFileVersion,
      globalVersion: nextGlobalVersion,
      deleted: true,
      deviceId: body.deviceId,
      now,
    });
    this.writeChange({
      globalVersion: nextGlobalVersion,
      opId: body.opId,
      path: body.file,
      oldPath: body.oldPath,
      oldFileVersion: sourceFileVersion,
      action: "rename",
      fileVersion: destinationFileVersion,
      deviceId: body.deviceId,
      chunksJson,
      mtime: body.mtime,
      size: body.size,
      now,
    });
    this.setGlobalVersion(nextGlobalVersion);

    return {
      success: true as const,
      fileVersion: destinationFileVersion,
      globalVersion: nextGlobalVersion,
    };
  }

  private recordConflict(
    body: CommitRequest,
    current: Record<string, unknown> | undefined,
    currentVersion: number,
  ) {
    this.sql.exec(
      `INSERT INTO conflicts (conflict_id, path, winning_global_version, losing_device_id, losing_chunks_json, losing_mtime, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      body.file,
      Number(current?.global_version ?? 0),
      body.deviceId,
      JSON.stringify(body.chunks),
      body.mtime,
      Date.now(),
    );
    return { success: false as const, conflict: true as const, currentVersion };
  }

  private missingChunks(chunks: readonly string[]): string[] {
    if (chunks.length === 0) return [];
    const known = new Set<string>();
    for (let start = 0; start < chunks.length; start += MAX_SQL_BOUND_PARAMETERS) {
      const batch = chunks.slice(start, start + MAX_SQL_BOUND_PARAMETERS);
      for (const row of this.sql
        .exec(`SELECT hash FROM chunks WHERE hash IN (${batch.map(() => "?").join(",")})`, ...batch)
        .toArray()) {
        known.add(String(row.hash));
      }
    }
    return chunks.filter((hash) => !known.has(hash));
  }

  private writeFile(entry: {
    path: string;
    chunksJson: string;
    mtime: number;
    size: number;
    fileVersion: number;
    globalVersion: number;
    deleted: boolean;
    deviceId: string;
    now: number;
  }) {
    this.sql.exec(
      `INSERT OR REPLACE INTO files
       (path, chunks_json, mtime, size, file_version, global_version, deleted, last_device_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.path,
      entry.chunksJson,
      entry.mtime,
      entry.size,
      entry.fileVersion,
      entry.globalVersion,
      entry.deleted ? 1 : 0,
      entry.deviceId,
      entry.now,
    );
  }

  private writeChange(entry: {
    globalVersion: number;
    opId: string;
    path: string;
    oldPath: string | null;
    oldFileVersion: number | null;
    action: "put" | "delete" | "rename";
    fileVersion: number;
    deviceId: string;
    chunksJson: string;
    mtime: number;
    size: number;
    now: number;
  }) {
    this.sql.exec(
      `INSERT INTO changes
       (global_version, op_id, path, old_path, old_file_version, action, file_version, device_id, chunks_json, mtime, size, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.globalVersion,
      entry.opId,
      entry.path,
      entry.oldPath,
      entry.oldFileVersion,
      entry.action,
      entry.fileVersion,
      entry.deviceId,
      entry.chunksJson,
      entry.mtime,
      entry.size,
      entry.now,
    );
  }

  private setGlobalVersion(globalVersion: number) {
    this.sql.exec(
      `INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('globalVersion', ?)`,
      String(globalVersion),
    );
  }

  async changes(body: ChangesQuery) {
    const { since: sinceVersion, through, limit = 100 } = body;
    if (!isValidChangesQuery(body)) {
      throw new Error("Invalid changes query");
    }
    const currentVersion = this.getGlobalVersion();
    const highWatermark = Math.min(through ?? currentVersion, currentVersion);
    if (highWatermark < sinceVersion) {
      throw new Error("through must be greater than or equal to since");
    }
    const changes = this.sql
      .exec(
        `SELECT * FROM changes
         WHERE global_version > ? AND global_version <= ?
         ORDER BY global_version ASC
         LIMIT ?`,
        sinceVersion,
        highWatermark,
        limit,
      )
      .toArray()
      .map((row) => ({
        globalVersion: Number(row.global_version),
        opId: String(row.op_id),
        path: String(row.path),
        oldPath: row.old_path ? String(row.old_path) : null,
        oldFileVersion:
          row.old_file_version === null || row.old_file_version === undefined
            ? null
            : Number(row.old_file_version),
        action: String(row.action),
        fileVersion: Number(row.file_version),
        deviceId: String(row.device_id),
        chunks: JSON.parse(String(row.chunks_json)) as string[],
        mtime: Number(row.mtime),
        size: Number(row.size),
        timestamp: Number(row.timestamp),
      }));

    const nextCursor = changes.at(-1)?.globalVersion ?? sinceVersion;
    return {
      changes,
      nextCursor,
      highWatermark,
      hasMore: nextCursor < highWatermark,
    };
  }

  async getFullIndex() {
    const files = this.sql
      .exec("SELECT * FROM files WHERE deleted = 0")
      .toArray()
      .map((row) => ({
        path: String(row.path),
        chunks: JSON.parse(String(row.chunks_json)) as string[],
        mtime: Number(row.mtime),
        size: Number(row.size),
        fileVersion: Number(row.file_version),
        globalVersion: Number(row.global_version),
      }));

    const tombstones = this.sql
      .exec("SELECT path, mtime, file_version, global_version FROM files WHERE deleted = 1")
      .toArray()
      .map((row) => ({
        path: String(row.path),
        mtime: Number(row.mtime),
        fileVersion: Number(row.file_version),
        globalVersion: Number(row.global_version),
      }));
    return { files, tombstones, globalVersion: this.getGlobalVersion() };
  }

  async getFileState({ path }: { path: FilePath }) {
    const row = this.queryOne("SELECT * FROM files WHERE path = ?", path);
    return {
      file: row
        ? {
            path: String(row.path),
            chunks: JSON.parse(String(row.chunks_json)) as string[],
            mtime: Number(row.mtime),
            size: Number(row.size),
            fileVersion: Number(row.file_version),
            globalVersion: Number(row.global_version),
            deleted: Number(row.deleted) !== 0,
          }
        : null,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const deviceId =
        request.headers.get("X-Device-Id") ?? new URL(request.url).searchParams.get("deviceId");
      if (!deviceId) return new Response("Unauthorized", { status: 401 });
      this.ctx.acceptWebSocket(pair[1], [deviceId]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("VaultDO", { status: 200 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    try {
      const msg = JSON.parse(text);
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (e) {
      console.error("[VaultDO] WS message parse error:", e);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason);
  }

  private closeDeviceSockets(deviceId: string): void {
    for (const ws of this.ctx.getWebSockets(deviceId)) ws.close(1008, "Device credentials changed");
  }

  private getGlobalVersion(): number {
    const row = this.queryOne("SELECT value FROM vault_meta WHERE key = 'globalVersion'");
    return row ? Number(row.value) : 0;
  }

  private nextGlobalVersion(): number {
    return this.getGlobalVersion() + 1;
  }

  private broadcast(message: unknown) {
    const json = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(json);
      } catch (e) {
        console.error("[VaultDO] broadcast error:", e);
      }
    }
  }
}

function findMissingChunk(sql: SqlStorage, chunks: readonly string[]): string | undefined {
  for (const hash of chunks) {
    const rows = sql.exec("SELECT hash FROM chunks WHERE hash = ?", hash).toArray();
    if (rows.length === 0) {
      return hash;
    }
  }
  return undefined;
}
