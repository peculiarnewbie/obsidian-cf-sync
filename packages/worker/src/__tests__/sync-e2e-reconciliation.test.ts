import { describe, expect, it } from "vitest";
import ObsidianCfSyncPlugin from "../../../plugin/src/main";
import {
  API_KEY,
  ORIGIN,
  network,
  plugins,
  vaultId,
  client,
  remote,
  converged,
} from "./sync-e2e-fixture";

describe("initial reconciliation", () => {
  it.each([false, true])(
    "adopts matching files and imports missing files (remote-only: %s)",
    async (extra) => {
      const a = await client();
      a.write("Welcome.md", "same welcome");
      if (extra) a.write("remote.md", "download me");
      await a.sync();
      const before = await remote(a);
      const b = await client(false);
      b.write("Welcome.md", "same welcome");
      await b.start();
      expect(b.engine.active).toBe(true);
      await converged(a, b);
      expect((await remote(a)).globalVersion).toBe(before.globalVersion);
      expect(b.snapshot()).toEqual(a.snapshot());
    },
  );

  it("unions local-only and remote-only files without inferring deletions", async () => {
    const a = await client();
    a.write("remote.md", "remote");
    await a.sync();
    const b = await client(false);
    b.write("local.md", "local");
    await b.start();
    await converged(a, b);
    expect(a.snapshot()).toEqual({ "remote.md": "remote", "local.md": "local" });
  });

  it("pauses differing shared paths, reports review status, and resumes after a local rename", async () => {
    const a = await client();
    a.write("shared.md", "remote version");
    a.write("remote.md", "not imported before review");
    await a.sync();
    const b = await client(false);
    b.write("shared.md", "local version");
    await b.state.init();
    const plugin = new ObsidianCfSyncPlugin(b.app, {
      id: "obsidian-cf-sync",
      name: "Sync",
      version: "test",
      minAppVersion: "1.0.0",
      author: "test",
      description: "test",
    });
    plugins.push(plugin);
    await plugin.saveData(b.settings);
    await plugin.onload();
    await plugin.saveSettings();
    b.engine = plugin.syncEngine!;
    const requestCount = network.requests.length;
    await plugin.saveSettings();
    await plugin.saveSettings();
    expect(plugin.syncEngine).toBe(b.engine);
    expect(network.requests).toHaveLength(requestCount);
    expect(b.engine.active).toBe(false);
    expect(b.engine.reconciliationPaths).toEqual(["shared.md"]);
    expect(b.snapshot()).toEqual({ "shared.md": "local version" });
    expect(await b.state.hasSyncState()).toBe(false);
    const dashboard = await network.fetch(`${ORIGIN}/admin/dashboard`, {
      headers: { Authorization: `Bearer ${API_KEY}`, "X-Vault-Id": vaultId },
    });
    expect(await dashboard.json()).toMatchObject({
      devices: expect.arrayContaining([
        expect.objectContaining({
          deviceId: b.settings.deviceId,
          state: "needs-review",
          reportedVersion: 0,
        }),
      ]),
    });
    b.rename("shared.md", "shared-local.md");
    await plugin.retryInitialSync();
    await converged(a, b);
    expect(b.snapshot()).toEqual({
      "shared.md": "remote version",
      "shared-local.md": "local version",
      "remote.md": "not imported before review",
    });
  });

  it("resumes a mixed-vault import from its saved snapshot after interruption", async () => {
    const a = await client();
    a.write("Welcome.md", "same");
    a.write("a.md", "first remote");
    a.write("b.md", "second remote");
    await a.sync();
    const b = await client(false);
    b.write("Welcome.md", "same");
    b.write("local.md", "retain local");
    const hash = (await remote(a)).files.find((file) => file.path === "b.md")!.chunks[0]!;
    const download = network.hold(b.settings.deviceId, `/sync/chunk/${hash}`);
    const start = b.start();
    await download.reached;
    download.release(true);
    await start;
    expect(await b.state.hasSyncState()).toBe(false);
    expect(b.snapshot()["local.md"]).toBe("retain local");
    expect(await b.state.getBootstrap()).toBeDefined();
    await b.restart();
    await converged(a, b);
    expect(b.snapshot()).toEqual({
      "Welcome.md": "same",
      "a.md": "first remote",
      "b.md": "second remote",
      "local.md": "retain local",
    });
  });
});
