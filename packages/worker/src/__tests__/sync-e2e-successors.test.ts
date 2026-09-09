import { describe, expect, it } from "vitest";
import { network, client, converged } from "./sync-e2e-fixture";

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
