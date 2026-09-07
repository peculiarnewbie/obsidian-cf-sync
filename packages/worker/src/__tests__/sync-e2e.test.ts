import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { SimulatedClient } from "../../../plugin/test-support/simulated-client";
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
let vaultId: string;

beforeEach(() => {
  network = new Network();
  clients = [];
  vaultId = `e2e-${crypto.randomUUID()}`;
  vi.stubGlobal("fetch", network.fetch);
  vi.stubGlobal("WebSocket", UnavailableWebSocket);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  network.releaseAll();
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

describe("delayed delivery and known recovery regressions", () => {
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

  // Expected failures assert the desired behavior, not today's broken result.
  // Fixing either regression produces an unexpected pass: remove .fails with the fix.
  it.fails("preserves an edit made after a rename committed but its acknowledgement was lost", async () => {
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

  it.fails("resumes a remote bootstrap interrupted after its first file was written", async () => {
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
