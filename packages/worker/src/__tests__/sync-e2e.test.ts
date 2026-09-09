import { describe, expect, it } from "vitest";
import { network, client, remote, converged } from "./sync-e2e-fixture";

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
