import { DurableObject } from "cloudflare:workers";
import type * as cf from "@cloudflare/workers-types";

interface Env {
  CHUNKS_BUCKET: R2Bucket;
  SYNC_API_KEY: { get(): string };
  VaultDO: cf.DurableObjectNamespace;
}

interface PrepareRequest {
  opId: string;
  file: string;
  chunks: string[];
  mtime: number;
  size: number;
  baseFileVersion: number;
  deviceId: string;
}

interface CommitRequest extends PrepareRequest {}

interface ChangeRecord {
  global_version: number;
  op_id: string;
  path: string;
  old_path: string | null;
  action: string;
  file_version: number;
  device_id: string;
  chunks_json: string;
  mtime: number;
  size: number;
  timestamp: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname.startsWith("/sync/ws")) {
      return handleWebSocket(request, env);
    }

    if (!checkAuth(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      if (url.pathname === "/sync/chunk/:hash") {
        return handleChunkUpload(request, env);
      }
      const path = url.pathname;
      if (path.startsWith("/sync/chunk/") && request.method === "PUT") {
        return handleChunkUpload(request, env);
      }
      if (path === "/sync/prepare" && request.method === "POST") {
        return handleRpc(env, "prepare", await request.json());
      }
      if (path === "/sync/commit" && request.method === "POST") {
        return handleRpc(env, "commit", await request.json());
      }
      if (path === "/sync/changes" && request.method === "GET") {
        const since = url.searchParams.get("since") ?? "0";
        return handleRpc(env, "changes", { since: parseInt(since) });
      }
      if (path === "/sync/index" && request.method === "GET") {
        return handleRpc(env, "getFullIndex", {});
      }
      if (path.startsWith("/sync/chunk/") && request.method === "GET") {
        return handleChunkDownload(request, env);
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  },
};

function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === env.SYNC_API_KEY.get();
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

async function handleRpc(env: Env, method: string, body: unknown): Promise<Response> {
  const stub = env.VaultDO.getByName("vault");
  const result = await (stub as any)[method](body);
  return Response.json(result);
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const stub = env.VaultDO.getByName("vault");
  return (stub as any).fetch(request);
}

async function handleChunkUpload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hash = url.pathname.split("/").pop();
  if (!hash) return new Response("Missing hash", { status: 400 });

  const body = await request.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", body);
  const computedHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (computedHash !== hash) {
    return new Response("Hash mismatch", { status: 400 });
  }

  await env.CHUNKS_BUCKET.put(`chunks/${hash}`, body);

  const stub = env.VaultDO.getByName("vault");
  await (stub as any).registerChunk({ hash, size: body.byteLength });

  return Response.json({ success: true, hash });
}

async function handleChunkDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hash = url.pathname.split("/").pop();
  if (!hash) return new Response("Missing hash", { status: 400 });

  const obj = await env.CHUNKS_BUCKET.get(`chunks/${hash}`);
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
    const { opId, file, chunks, baseFileVersion, deviceId } = body;

    const existingOp = this.queryOne("SELECT global_version FROM changes WHERE op_id = ?", opId);
    if (existingOp) {
      return {
        success: true,
        alreadyCommitted: true,
        globalVersion: Number(existingOp.global_version),
      };
    }

    const current = this.queryOne("SELECT file_version, chunks_json FROM files WHERE path = ?", file);
    const currentVersion = Number(current?.file_version ?? 0);

    if (currentVersion > 0 && baseFileVersion < currentVersion) {
      return {
        success: false,
        conflict: true,
        currentVersion,
        currentChunks: current
          ? JSON.parse(String(current.chunks_json))
          : [],
      };
    }

    const known = new Set(
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
    const { opId, file, chunks, mtime, size, baseFileVersion, deviceId } =
      body;

    const existingOp = this.queryOne("SELECT global_version FROM changes WHERE op_id = ?", opId);
    if (existingOp) {
      return {
        success: true,
        alreadyCommitted: true,
        globalVersion: Number(existingOp.global_version),
      };
    }

    const current = this.queryOne("SELECT file_version FROM files WHERE path = ?", file);
    const currentVersion = Number(current?.file_version ?? 0);

    if (currentVersion > 0 && baseFileVersion < currentVersion) {
      const conflictId = crypto.randomUUID();
      const currentChunks = this.queryOne("SELECT chunks_json FROM files WHERE path = ?", file);
      this.sql.exec(
        `INSERT INTO conflicts (conflict_id, path, winning_global_version, losing_device_id, losing_chunks_json, losing_mtime, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        conflictId,
        file,
        currentVersion,
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

    assertChunksKnown(this.sql, chunks);

    const nextGlobalVersion = this.nextGlobalVersion();
    const nextFileVersion = currentVersion + 1;
    const now = Date.now();
    const chunksJson = JSON.stringify(chunks);

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
    this.sql.exec(
      `INSERT INTO changes
       (global_version, op_id, path, action, file_version, device_id, chunks_json, mtime, size, timestamp)
       VALUES (?, ?, ?, 'update', ?, ?, ?, ?, ?, ?)`,
      nextGlobalVersion,
      opId,
      file,
      nextFileVersion,
      deviceId,
      chunksJson,
      mtime,
      size,
      now,
    );
    this.sql.exec(
      `INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('globalVersion', ?)`,
      String(nextGlobalVersion),
    );

    this.broadcast({
      type: "file_changed",
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
    const text =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(message);
    try {
      const msg = JSON.parse(text);
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {}
  }

  async webSocketClose(ws: WebSocket) {}

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
      } catch {}
    }
  }
}

function assertChunksKnown(sql: SqlStorage, chunks: string[]) {
  for (const hash of chunks) {
    const rows = sql.exec("SELECT hash FROM chunks WHERE hash = ?", hash).toArray();
    if (rows.length === 0) {
      throw new Error(`Chunk ${hash} not registered. Upload it first.`);
    }
  }
}
