import { afterEach, beforeEach, expect, vi } from "vitest";
import { SELF } from "cloudflare:test";
import ObsidianCfSyncPlugin from "../../../plugin/src/main";
import { SimulatedClient, IDBFactory } from "../../../plugin/test-support/simulated-client";
import {
  DeviceEnrollmentResponse,
  FullIndexResponse,
  decodeUnknownSync,
} from "@obsidian-cf-sync/protocol";

export const API_KEY = "e2e-bootstrap";
export const ORIGIN = "https://sync.test";

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

export let network: Network;
let clients: SimulatedClient[];
export let plugins: ObsidianCfSyncPlugin[];
export let vaultId: string;

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

export async function client(start = true) {
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

export async function remote(client: SimulatedClient) {
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

export async function converged(a: SimulatedClient, b: SimulatedClient) {
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
