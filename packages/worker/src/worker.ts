import { DurableObject } from "cloudflare:workers";
import type * as cf from "@cloudflare/workers-types";
import {
  ChunkHash as ChunkHashSchema,
  CommitRequest as CommitRequestSchema,
  PrepareRequest as PrepareRequestSchema,
  VaultId as VaultIdSchema,
  decodeUnknownSync,
  type CommitRequest,
  type PrepareRequest,
  type VaultId,
} from "@obsidian-cf-sync/protocol";

interface Env {
  CHUNKS_BUCKET: R2Bucket;
  SYNC_API_KEY: string | { get(): string };
  VaultDO: cf.DurableObjectNamespace;
}

interface ChangesRequest {
  since: number;
}

interface RpcContext {
  vaultId: VaultId;
}

// JSON error response helper
function errorResponse(
  e: { error: string; code?: string; details?: Record<string, unknown> },
  status = 400,
): Response {
  return Response.json(e, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!checkAuth(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const context = getRpcContext(request);
    if (!context.ok) return errorResponse({ error: context.error, code: "INVALID_VAULT_ID" });

    if (url.pathname.startsWith("/sync/ws")) {
      return handleWebSocket(request, env, context.data);
    }

    try {
      if (url.pathname === "/sync/chunk/:hash") {
        return await handleChunkUpload(request, env, context.data);
      }
      const path = url.pathname;
      if (path.startsWith("/sync/chunk/") && request.method === "PUT") {
        return await handleChunkUpload(request, env, context.data);
      }
      if (path === "/sync/prepare" && request.method === "POST") {
        const validated = decodeRequest(PrepareRequestSchema, await request.json());
        if (!validated.ok) return errorResponse(validated);
        return await handleRpc(env, context.data, "prepare", validated.data);
      }
      if (path === "/sync/commit" && request.method === "POST") {
        const validated = decodeRequest(CommitRequestSchema, await request.json());
        if (!validated.ok) return errorResponse(validated);
        return await handleRpc(env, context.data, "commit", validated.data);
      }
      if (path === "/sync/changes" && request.method === "GET") {
        const sinceParam = url.searchParams.get("since");
        const sinceValue = sinceParam !== null ? parseInt(sinceParam, 10) : 0;
        if (isNaN(sinceValue) || sinceValue < 0) {
          return errorResponse({
            error: "since must be a non-negative number",
            code: "INVALID_SINCE",
          });
        }
        return await handleRpc(env, context.data, "changes", { since: sinceValue });
      }
      if (path === "/sync/index" && request.method === "GET") {
        return await handleRpc(env, context.data, "getFullIndex", undefined);
      }
      if (path.startsWith("/sync/chunk/") && request.method === "GET") {
        return await handleChunkDownload(request, env);
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return handleRouteError(e);
    }
  },
};

function checkAuth(request: Request, env: Env): boolean {
  const expected = typeof env.SYNC_API_KEY === "string" ? env.SYNC_API_KEY : env.SYNC_API_KEY.get();
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (token) return token === expected;

  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === expected;
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

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function handleRouteError(e: unknown): Response {
  if (e instanceof Error) {
    return Response.json({ error: e.message }, { status: 500 });
  }
  return Response.json({ error: "Internal server error" }, { status: 500 });
}

type RpcBody = PrepareRequest | CommitRequest | ChangesRequest | undefined;

type VaultDOStub = {
  prepare(body: PrepareRequest): Promise<unknown>;
  commit(body: CommitRequest): Promise<unknown>;
  changes(body: { since: number }): Promise<unknown>;
  getFullIndex(): Promise<unknown>;
  registerChunk(body: { hash: string; size: number }): Promise<{ success: true }>;
  fetch(request: Request): Promise<Response>;
};

async function handleRpc(
  env: Env,
  context: RpcContext,
  method: string,
  body: RpcBody,
): Promise<Response> {
  const stub = env.VaultDO.getByName(context.vaultId) as unknown as VaultDOStub;
  if (method === "changes") {
    const result = await stub.changes({ since: (body as ChangesRequest)?.since ?? 0 });
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

  const body = await request.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", body);
  const computedHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (computedHash !== hash.data) {
    return new Response("Hash mismatch", { status: 400 });
  }

  await env.CHUNKS_BUCKET.put(`chunks/${hash.data}`, body);

  const stub = env.VaultDO.getByName(context.vaultId) as unknown as VaultDOStub;
  await stub.registerChunk({ hash: hash.data, size: body.byteLength });

  return Response.json({ success: true, hash: hash.data });
}

async function handleChunkDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawHash = url.pathname.split("/").pop();
  if (!rawHash) return new Response("Missing hash", { status: 400 });
  const hash = decodeRequest(ChunkHashSchema, rawHash);
  if (!hash.ok) return errorResponse(hash);

  const obj = await env.CHUNKS_BUCKET.get(`chunks/${hash.data}`);
  if (!obj) return new Response("Not found", { status: 404 });

  return new Response(obj.body, {
    headers: { "Content-Type": "application/octet-stream" },
  });
}

export class VaultDO extends DurableObject {
  private sql!: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
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
        revoked INTEGER NOT NULL DEFAULT 0
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

  async prepare(body: PrepareRequest) {
    const { opId, file, chunks, baseFileVersion } = body;

    const existingOp = this.queryOne(
      "SELECT global_version, file_version FROM changes WHERE op_id = ?",
      opId,
    );
    if (existingOp) {
      return {
        success: true,
        alreadyCommitted: true,
        globalVersion: Number(existingOp.global_version),
        fileVersion: Number(existingOp.file_version),
      };
    }

    const current = this.queryOne(
      "SELECT file_version, chunks_json FROM files WHERE path = ?",
      file,
    );
    const currentVersion = Number(current?.file_version ?? 0);

    if (currentVersion > 0 && baseFileVersion < currentVersion) {
      return {
        success: false,
        conflict: true,
        currentVersion,
        currentChunks: current ? JSON.parse(String(current.chunks_json)) : [],
      };
    }

    const known =
      chunks.length === 0
        ? new Set<string>()
        : new Set(
            this.sql
              .exec(
                `SELECT hash FROM chunks WHERE hash IN (${chunks.map(() => "?").join(",")})`,
                ...chunks,
              )
              .toArray()
              .map((row) => String(row.hash)),
          );
    const missing = chunks.filter((hash) => !known.has(hash));

    return {
      success: true,
      missing,
      currentVersion,
    };
  }

  async commit(body: CommitRequest) {
    const { opId, action, file, chunks, mtime, size, baseFileVersion, deviceId } = body;

    const existingOp = this.queryOne(
      "SELECT global_version, file_version FROM changes WHERE op_id = ?",
      opId,
    );
    if (existingOp) {
      return {
        success: true,
        alreadyCommitted: true,
        globalVersion: Number(existingOp.global_version),
        fileVersion: Number(existingOp.file_version),
      };
    }

    const current = this.queryOne(
      "SELECT file_version, global_version FROM files WHERE path = ?",
      file,
    );
    const currentVersion = Number(current?.file_version ?? 0);

    if (currentVersion > 0 && baseFileVersion < currentVersion) {
      const conflictId = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO conflicts (conflict_id, path, winning_global_version, losing_device_id, losing_chunks_json, losing_mtime, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        conflictId,
        file,
        Number(current?.global_version ?? 0),
        deviceId,
        JSON.stringify(chunks),
        mtime,
        Date.now(),
      );
      return {
        success: false,
        conflict: true,
        currentVersion,
      };
    }

    if (action === "put") {
      const missingChunk = findMissingChunk(this.sql, chunks);
      if (missingChunk) {
        return {
          success: false,
          error: `Chunk ${missingChunk} not registered. Upload it first.`,
          code: "CHUNK_NOT_REGISTERED",
        };
      }
    }

    const nextGlobalVersion = this.nextGlobalVersion();
    const nextFileVersion = currentVersion + 1;
    const now = Date.now();
    const chunksJson = JSON.stringify(chunks);

    if (action === "delete") {
      this.sql.exec(
        `INSERT OR REPLACE INTO files
         (path, chunks_json, mtime, size, file_version, global_version, deleted, last_device_id, updated_at)
         VALUES (?, '[]', ?, 0, ?, ?, 1, ?, ?)`,
        file,
        mtime,
        nextFileVersion,
        nextGlobalVersion,
        deviceId,
        now,
      );
    } else {
      this.sql.exec(
        `INSERT OR REPLACE INTO files
         (path, chunks_json, mtime, size, file_version, global_version, deleted, last_device_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        file,
        chunksJson,
        mtime,
        size,
        nextFileVersion,
        nextGlobalVersion,
        deviceId,
        now,
      );
    }
    this.sql.exec(
      `INSERT INTO changes
       (global_version, op_id, path, action, file_version, device_id, chunks_json, mtime, size, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nextGlobalVersion,
      opId,
      file,
      action,
      nextFileVersion,
      deviceId,
      action === "delete" ? "[]" : chunksJson,
      mtime,
      action === "delete" ? 0 : size,
      now,
    );
    this.sql.exec(
      `INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('globalVersion', ?)`,
      String(nextGlobalVersion),
    );

    this.broadcast({
      type: "file_changed",
      action,
      file,
      fileVersion: nextFileVersion,
      globalVersion: nextGlobalVersion,
      deviceId,
    });

    return {
      success: true,
      fileVersion: nextFileVersion,
      globalVersion: nextGlobalVersion,
    };
  }

  async changes(body: { since: number }) {
    const sinceVersion = body.since;
    const globalVersion = this.getGlobalVersion();
    const changes = this.sql
      .exec(
        "SELECT * FROM changes WHERE global_version > ? ORDER BY global_version ASC",
        sinceVersion,
      )
      .toArray()
      .map((row) => ({
        globalVersion: Number(row.global_version),
        opId: String(row.op_id),
        path: String(row.path),
        oldPath: row.old_path ? String(row.old_path) : null,
        action: String(row.action),
        fileVersion: Number(row.file_version),
        deviceId: String(row.device_id),
        chunks: JSON.parse(String(row.chunks_json)),
        mtime: Number(row.mtime),
        size: Number(row.size),
        timestamp: Number(row.timestamp),
      }));

    return { changes, globalVersion };
  }

  async getFullIndex() {
    const files = this.sql
      .exec("SELECT * FROM files WHERE deleted = 0")
      .toArray()
      .map((row) => ({
        path: String(row.path),
        chunks: JSON.parse(String(row.chunks_json)),
        mtime: Number(row.mtime),
        size: Number(row.size),
        fileVersion: Number(row.file_version),
        globalVersion: Number(row.global_version),
      }));

    return { files, globalVersion: this.getGlobalVersion() };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
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

  async webSocketClose(_ws: WebSocket) {}

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
