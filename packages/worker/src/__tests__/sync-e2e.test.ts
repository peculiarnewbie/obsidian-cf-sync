import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import ObsidianCfSyncPlugin from "../../../plugin/src/main";
import { SimulatedClient, IDBFactory } from "../../../plugin/test-support/simulated-client";
import {
  DeviceEnrollmentResponse,
  FullIndexResponse,
  decodeUnknownSync,
} from "@obsidian-cf-sync/protocol";

const API_KEY = "e2e-bootstrap";
const ORIGIN = "https://sync.test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Fault = {
  device: string;
  path: string;
  phase: "request" | "response";
  reached: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<boolean>>;
};

/** Requests reach the real Worker and real local DO/R2 bindings. Only delivery is controlled. */
class Network {
  offline = new Set<string>();
  corruptOnce = new Set<string>();
  requests: { device: string; path: string; method: string }[] = [];
  private faults: Fault[] = [];
  private active = new Set<Fault>();

  hold(device: string, path: string, phase: Fault["phase"] = "response") {
    const fault: Fault = {
      device,
      path,
      phase,
      reached: deferred<void>(),
      release: deferred<boolean>(),
    };
    this.faults.push(fault);
    return {
      reached: fault.reached.promise,
      release: (drop = false) => fault.release.resolve(drop),
    };
  }

  releaseAll() {
    for (const fault of [...this.faults, ...this.active]) fault.release.resolve(true);
    this.faults = [];
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const device = request.headers.get("X-Device-Id") ?? "";
    const path = new URL(request.url).pathname;
    this.requests.push({ device, path, method: request.method });
    if (this.offline.has(device)) throw new TypeError("Simulated offline client");
    const index = this.faults.findIndex((f) => f.device === device && f.path === path);
    const fault = index < 0 ? undefined : this.faults.splice(index, 1)[0];
    const pause = async () => {
      if (!fault) return;
      this.active.add(fault);
      fault.reached.resolve();
      const drop = await fault.release.promise;
      this.active.delete(fault);
      if (drop) throw new TypeError("Simulated lost delivery");
    };
    if (fault?.phase === "request") await pause();
    const response = await SELF.fetch(request);
    // Drain the runtime response even when delivery is dropped, so abandoned
    // bodies do not keep workerd streams alive between isolated tests.
    const body = await response.arrayBuffer();
    if (fault?.phase === "response") await pause();
    if (this.corruptOnce.delete(`${device}:${path}`)) {
      return new Response(new Uint8Array([0, 1, 2]), {
        status: response.status,
        headers: response.headers,
      });
    }
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

// No notifications reach the clients: all convergence must come from catch-up.
class UnavailableWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  close() {
    this.readyState = 3;
  }
}

let network: Network;
let clients: SimulatedClient[];
let plugins: ObsidianCfSyncPlugin[];
let vaultId: string;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  network = new Network();
  clients = [];
  plugins = [];
  vaultId = `e2e-${crypto.randomUUID()}`;
  vi.stubGlobal("fetch", network.fetch);
  vi.stubGlobal("WebSocket", UnavailableWebSocket);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  network.releaseAll();
  for (const plugin of plugins) {
    plugin.onunload();
    await plugin.syncEngine?.shutdown();
  }
  await Promise.all(clients.map((client) => client.stop()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function client(start = true) {
  const deviceId = crypto.randomUUID();
  const response = await network.fetch(`${ORIGIN}/devices/enroll`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "X-Vault-Id": vaultId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ deviceId, name: deviceId, platform: "simulated-obsidian" }),
  });
  expect(response.status).toBe(200);
  const { deviceToken } = decodeUnknownSync(DeviceEnrollmentResponse)(await response.json());
  const result = new SimulatedClient({
    workerUrl: ORIGIN,
    vaultId,
    deviceId,
    deviceToken,
    apiKey: "",
    enabled: true,
    syncInterval: 60_000,
  });
  clients.push(result);
  if (start) {
    await result.start();
    expect(result.engine.active).toBe(true);
  }
  return result;
}

async function remote(client: SimulatedClient) {
  const response = await network.fetch(`${ORIGIN}/sync/index`, {
    headers: {
      Authorization: `Bearer ${client.settings.deviceToken}`,
      "X-Vault-Id": vaultId,
      "X-Device-Id": client.settings.deviceId,
    },
  });
  expect(response.status).toBe(200);
  return decodeUnknownSync(FullIndexResponse)(await response.json());
}

async function converged(a: SimulatedClient, b: SimulatedClient) {
  // Bounded protocol rounds, not timing-based polling. Conflicts create additional files.
  for (let round = 0; round < 3; round++) {
    await a.sync();
    await b.sync();
  }
  expect(a.snapshot()).toEqual(b.snapshot());
  expect(await a.state.getPendingOps()).toEqual([]);
  expect(await b.state.getPendingOps()).toEqual([]);
  const index = await remote(a);
  expect(Object.keys(a.snapshot()).sort()).toEqual(index.files.map((f) => f.path).sort());
  for (const c of [a, b]) {
    expect((await c.state.getSyncState()).globalVersion).toBe(index.globalVersion);
    for (const file of index.files) {
      expect(await c.state.getFile(file.path)).toMatchObject({
        chunks: file.chunks,
        fileVersion: file.fileVersion,
      });
    }
  }
  return index;
}

describe("two SyncEngines against local Worker / Durable Object / R2", () => {
  it("converges through create, multi-chunk content, edit, rename, delete, and recreation without WebSockets", async () => {
    const a = await client();
    const b = await client();
    const content = "x".repeat(256 * 1024) + "second chunk";
    a.write("notes/a.md", content);
    await converged(a, b);
    expect(b.snapshot()["notes/a.md"]).toBe(content);
    b.write("notes/a.md", "edited on B");
    await converged(a, b);
    a.rename("notes/a.md", "notes/b.md");
    await converged(a, b);
    expect(b.snapshot()).toEqual({ "notes/b.md": "edited on B" });
    b.remove("notes/b.md");
    await converged(a, b);
    a.write("notes/b.md", "recreated");
    await converged(a, b);
    expect(b.snapshot()).toEqual({ "notes/b.md": "recreated" });
  });

  it("imports a populated remote vault into a fresh client", async () => {
    const a = await client();
    a.write("a.md", "remote content");
    a.write("empty.md", "");
    await a.sync();
    const b = await client();
    await converged(a, b);
    expect(b.snapshot()).toEqual({ "a.md": "remote content", "empty.md": "" });
  });

  it("keeps offline edits in IndexedDB and retries after engine restart", async () => {
    const a = await client();
    const b = await client();
    network.offline.add(a.settings.deviceId);
    a.write("offline.md", "survives restart");
    await a.sync();
    expect(await a.state.getPendingOps()).toHaveLength(1);
    await a.restart();
    expect(await a.state.getPendingOps()).toHaveLength(1);
    network.offline.delete(a.settings.deviceId);
    await converged(a, b);
    expect(b.snapshot()).toEqual({ "offline.md": "survives restart" });
  });

  it("does not advance a receiver cursor until a delayed chunk download completes", async () => {
    const a = await client();
    const b = await client();
    a.write("delayed.md", "download must finish first");
    await a.sync();
    const index = await remote(a);
    const hash = index.files[0]!.chunks[0]!;
    const delayed = network.hold(b.settings.deviceId, `/sync/chunk/${hash}`);
    const receiving = b.sync();
    await delayed.reached;
    expect((await b.state.getSyncState()).globalVersion).toBe(0);
    expect(b.snapshot()).toEqual({});
    delayed.release();
    await receiving;
    await converged(a, b);
  });

  it("retries a committed put after its acknowledgement is lost without a duplicate server mutation", async () => {
    const a = await client();
    const b = await client();
    a.write("ack.md", "committed once");
    const ack = network.hold(a.settings.deviceId, "/sync/commit");
    const sending = a.sync();
    await ack.reached;
    expect((await remote(b)).globalVersion).toBe(1);
    network.offline.add(a.settings.deviceId);
    ack.release(true);
    await sending;
    expect(await a.state.getPendingOps()).toHaveLength(1);
    await a.restart();
    network.offline.delete(a.settings.deviceId);
    const index = await converged(a, b);
    expect(index.globalVersion).toBe(1);
    expect(b.snapshot()).toEqual({ "ack.md": "committed once" });
  });

  it("recovers a partially acknowledged multi-chunk upload after restart", async () => {
    const a = await client();
    const b = await client();
    const tail = "last upload chunk";
    const content = "x".repeat(256 * 1024) + tail;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tail));
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const upload = network.hold(a.settings.deviceId, `/sync/chunk/${hash}`);
    a.write("attachment.md", content);
    const sending = a.sync();
    await upload.reached;
    expect((await remote(b)).files).toEqual([]);
    network.offline.add(a.settings.deviceId);
    upload.release(true);
    await sending;
    expect(await a.state.getPendingOps()).toHaveLength(1);
    await a.restart();
    network.offline.delete(a.settings.deviceId);
    const index = await converged(a, b);
    expect(index.globalVersion).toBe(1);
    expect(b.snapshot()).toEqual({ "attachment.md": content });
  });

  it("preserves both concurrent edits when a delayed commit loses the version race", async () => {
    const a = await client();
    const b = await client();
    a.write("shared.md", "base");
    await converged(a, b);
    a.write("shared.md", "edit A");
    const delayed = network.hold(a.settings.deviceId, "/sync/commit", "request");
    const sending = a.sync();
    await delayed.reached;
    b.write("shared.md", "edit B");
    await b.sync();
    delayed.release();
    await sending;
    await converged(a, b);
    expect(Object.values(a.snapshot())).toContain("edit A");
    expect(Object.values(a.snapshot())).toContain("edit B");
    expect(a.snapshot()["shared.md"]).toBe("edit B");
  });
});

describe("delayed delivery and recovery regressions", () => {
  it("catches up after an older change-page response arrives behind a newer server commit", async () => {
    const a = await client();
    const b = await client();
    a.write("ordered.md", "version one");
    await a.sync();
    const page = network.hold(b.settings.deviceId, "/sync/changes");
    const receiving = b.sync();
    await page.reached;
    a.write("ordered.md", "version two");
    await a.sync();
    expect((await remote(a)).globalVersion).toBe(2);
    expect((await b.state.getSyncState()).globalVersion).toBe(0);
    page.release();
    await receiving;
    await converged(a, b);
    expect(b.snapshot()).toEqual({ "ordered.md": "version two" });
  });

  it("preserves an edit made after a rename committed but its acknowledgement was lost", async () => {
    const a = await client();
    const b = await client();
    a.write("before.md", "original");
    await converged(a, b);
    a.rename("before.md", "after.md");
    const ack = network.hold(a.settings.deviceId, "/sync/commit");
    const sending = a.sync();
    await ack.reached;
    expect((await remote(b)).files.map((f) => f.path)).toEqual(["after.md"]);
    network.offline.add(a.settings.deviceId);
    ack.release(true);
    await sending;
    a.write("after.md", "edit after ambiguous rename");
    await a.sync();
    await a.restart();
    network.offline.delete(a.settings.deviceId);
    await converged(a, b);
    expect(Object.values(a.snapshot())).toContain("edit after ambiguous rename");
  });

  it("resumes a remote bootstrap interrupted after its first file was written", async () => {
    const a = await client();
    a.write("a.md", "first imported file");
    a.write("b.md", "second imported file");
    await a.sync();
    const index = await remote(a);
    const second = index.files.find((f) => f.path === "b.md")!;
    const b = await client(false);
    const download = network.hold(b.settings.deviceId, `/sync/chunk/${second.chunks[0]}`);
    const starting = b.start();
    await download.reached;
    expect(b.snapshot()).toEqual({ "a.md": "first imported file" });
    download.release(true);
    await starting;
    expect(b.engine.active).toBe(false);
    await b.restart();
    expect(b.engine.active).toBe(true);
    await converged(a, b);
  });
});

describe("client safety boundaries", () => {
  it("retains tombstone versions when a fresh client recreates a deleted path", async () => {
    const a = await client();
    a.write("reused.md", "original");
    await a.sync();
    a.remove("reused.md");
    await a.sync();
    const b = await client();
    expect(await b.state.getFile("reused.md")).toMatchObject({ deleted: true, fileVersion: 2 });
    b.write("reused.md", "fresh recreation");
    await converged(a, b);
    expect(a.snapshot()).toEqual({ "reused.md": "fresh recreation" });
  });

  it("rejects a corrupt chunk without caching it or advancing past that change", async () => {
    const a = await client();
    const b = await client();
    a.write("verified.md", "verified content");
    await a.sync();
    const hash = (await remote(a)).files[0]!.chunks[0]!;
    network.corruptOnce.add(`${b.settings.deviceId}:/sync/chunk/${hash}`);
    // After the failed first catch-up, hold the retry to inspect persisted state.
    const first = network.hold(b.settings.deviceId, `/sync/chunk/${hash}`);
    const receiving = b.sync();
    await first.reached;
    const retry = network.hold(b.settings.deviceId, `/sync/chunk/${hash}`);
    first.release();
    await retry.reached;
    expect(await b.state.getChunkData(hash)).toBeUndefined();
    expect((await b.state.getSyncState()).globalVersion).toBe(0);
    expect(b.snapshot()).toEqual({});
    retry.release();
    await receiving;
    await converged(a, b);
    expect(b.snapshot()).toEqual({ "verified.md": "verified content" });
  });

  it("skips incoming configuration files while continuing the ordered change log", async () => {
    const a = await client();
    const b = await client();
    const response = await network.fetch(`${ORIGIN}/sync/commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${a.settings.deviceToken}`,
        "X-Vault-Id": vaultId,
        "X-Device-Id": a.settings.deviceId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        opId: crypto.randomUUID(),
        action: "put",
        file: ".obsidian/plugins/other/main.js",
        chunks: [],
        size: 0,
        mtime: 1,
        baseFileVersion: 0,
        deviceId: a.settings.deviceId,
      }),
    });
    expect(await response.json()).toMatchObject({ success: true });
    await b.sync();
    expect(b.snapshot()).toEqual({});
    expect((await b.state.getSyncState()).globalVersion).toBe(1);
    a.write("ordinary.md", "still syncs");
    await a.sync();
    await b.sync();
    expect(b.snapshot()).toEqual({ "ordinary.md": "still syncs" });
  });

  it("does not mutate local files after shutdown while a download is delayed", async () => {
    const a = await client();
    const b = await client();
    a.write("delayed-stop.md", "must wait for a new engine");
    await a.sync();
    const hash = (await remote(a)).files[0]!.chunks[0]!;
    const download = network.hold(b.settings.deviceId, `/sync/chunk/${hash}`);
    const receiving = b.sync();
    await download.reached;
    const stopping = b.stop();
    download.release();
    await Promise.all([receiving, stopping]);
    expect(b.snapshot()).toEqual({});
    expect((await b.state.getSyncState()).globalVersion).toBe(0);
    await b.restart();
    await converged(a, b);
  });
});

describe("successors of operations with lost acknowledgements", () => {
  it("keeps a deletion queued behind an ambiguously committed creation", async () => {
    const a = await client();
    const b = await client();
    a.write("temporary.md", "created before deletion");
    const ack = network.hold(a.settings.deviceId, "/sync/commit");
    const sending = a.sync();
    await ack.reached;
    network.offline.add(a.settings.deviceId);
    ack.release(true);
    await sending;
    a.remove("temporary.md");
    await a.sync();
    expect(await a.state.getPendingOps()).toHaveLength(2);
    await a.restart();
    network.offline.delete(a.settings.deviceId);
    await converged(a, b);
    expect(a.snapshot()).toEqual({});
  });

  it("keeps a second rename queued behind an ambiguously committed first rename", async () => {
    const a = await client();
    const b = await client();
    a.write("one.md", "rename chain");
    await converged(a, b);
    a.rename("one.md", "two.md");
    const ack = network.hold(a.settings.deviceId, "/sync/commit");
    const sending = a.sync();
    await ack.reached;
    network.offline.add(a.settings.deviceId);
    ack.release(true);
    await sending;
    a.rename("two.md", "three.md");
    await a.sync();
    expect(await a.state.getPendingOps()).toHaveLength(2);
    network.offline.delete(a.settings.deviceId);
    await converged(a, b);
    expect(a.snapshot()).toEqual({ "three.md": "rename chain" });
  });
});

describe("plugin lifecycle and idle work", () => {
  it("stops on disable, resumes on enable, and keeps the active engine for unchanged sync identity", async () => {
    const a = await client();
    const b = await client();
    await a.stop();
    const plugin = new ObsidianCfSyncPlugin(a.app, {
      id: "obsidian-cf-sync",
      name: "Sync",
      version: "test",
      minAppVersion: "1.0.0",
      author: "test",
      description: "test",
    });
    plugins.push(plugin);
    await plugin.saveData(a.settings);
    await plugin.onload();
    const active = plugin.syncEngine;
    expect(active?.active).toBe(true);
    plugin.settings.apiKey = "administrative setting only";
    await plugin.saveSettings();
    expect(plugin.syncEngine).toBe(active);
    plugin.settings.enabled = false;
    await plugin.saveSettings();
    expect(active?.active).toBe(false);
    expect(plugin.syncEngine).toBeNull();
    a.write("while-disabled.md", "local until enabled");
    await b.sync();
    expect(b.snapshot()).toEqual({});
    plugin.settings.enabled = true;
    await plugin.saveSettings();
    await plugin.syncEngine?.syncNow();
    await b.sync();
    expect(b.snapshot()).toEqual({ "while-disabled.md": "local until enabled" });
  });

  it("does not repeatedly read unchanged file bodies during idle coordinator passes", async () => {
    const a = await client();
    const b = await client();
    a.write("unchanged.md", "no repeated hashing");
    await converged(a, b);
    const reads = [a.reads, b.reads];
    await converged(a, b);
    expect([a.reads, b.reads]).toEqual(reads);
  });
});
