import { describe, expect, it } from "vitest";
import { network, client, remote, converged } from "./sync-e2e-fixture";

describe("delayed delivery and recovery regressions", () => {
  it("does not conflict when typing continues during an acknowledgement and editing switches devices", async () => {
    const a = await client();
    const b = await client();
    a.write("handoff.md", "initial");
    await converged(a, b);
    for (let round = 0; round < 4; round++) {
      const writer = round % 2 === 0 ? a : b;
      writer.write("handoff.md", `round ${round} typing`);
      const ack = network.hold(writer.settings.deviceId, "/sync/commit");
      const sending = writer.sync();
      await ack.reached;
      writer.write("handoff.md", `round ${round} finished`);
      ack.release();
      await sending;
      await converged(a, b);
      expect(a.snapshot()).toEqual({ "handoff.md": `round ${round} finished` });
    }
  });

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
