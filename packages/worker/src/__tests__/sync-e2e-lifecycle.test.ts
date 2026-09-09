import { describe, expect, it } from "vitest";
import ObsidianCfSyncPlugin from "../../../plugin/src/main";
import { network, plugins, client, converged } from "./sync-e2e-fixture";

describe("plugin lifecycle and idle work", () => {
  it.each([false, true])(
    "finishes plugin loading before layout readiness (unloaded: %s)",
    async (unload) => {
      const a = await client(false);
      const b = await client();
      b.write("startup.md", "download after launch");
      await b.sync();
      let ready: (() => void) | undefined;
      a.app.workspace.layoutReady = false;
      a.app.workspace.onLayoutReady = (callback) => {
        ready = callback;
      };
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
      const requests = network.requests.length;
      // Awaiting onload before emitting layout-ready reproduces Obsidian's launch order.
      await plugin.onload();
      expect(ready).toBeTypeOf("function");
      expect(network.requests).toHaveLength(requests);
      expect(plugin.syncEngine).toBeNull();
      if (unload) plugin.onunload();
      a.app.workspace.layoutReady = true;
      ready!();
      await plugin.saveSettings();
      if (unload) {
        expect(plugin.syncEngine).toBeNull();
        expect(network.requests).toHaveLength(requests);
      } else {
        await plugin.syncEngine?.syncNow();
        expect(a.snapshot()).toEqual({ "startup.md": "download after launch" });
      }
    },
  );

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
    await plugin.saveSettings();
    await plugin.syncEngine?.syncNow();
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
