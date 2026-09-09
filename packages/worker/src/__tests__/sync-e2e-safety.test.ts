import { describe, expect, it } from "vitest";
import { ORIGIN, network, plugins, vaultId, client, remote, converged } from "./sync-e2e-fixture";

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
