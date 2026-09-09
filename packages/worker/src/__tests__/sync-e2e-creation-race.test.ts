import { describe, expect, it } from "vitest";
import { client, converged, network, remote } from "./sync-e2e-fixture";

describe("local-only creation races", () => {
  it.each(["catch-up", "prepare", "commit"] as const)(
    "preserves a queued local creation when the remote wins before %s",
    async (phase) => {
      const a = await client();
      a.write("remote.md", "existing remote file");
      await a.sync();
      const b = await client(false);
      b.write("local.md", "local creation");
      // Stop startup after the initial snapshot has been received.
      const index = network.hold(b.settings.deviceId, "/sync/index");
      const starting = b.start();
      await index.reached;
      const gate = network.hold(
        b.settings.deviceId,
        phase === "catch-up" ? "/sync/changes" : `/sync/${phase}`,
        "request",
      );
      index.release();
      await gate.reached;
      a.write("local.md", "remote creation");
      await a.sync();
      gate.release();
      await starting;
      await converged(a, b);
      const snapshot = b.snapshot();
      expect(snapshot["local.md"]).toBe("remote creation");
      const copies = Object.entries(snapshot).filter(([path]) => path.includes("(conflict"));
      expect(copies).toHaveLength(1);
      expect(copies[0]![1]).toBe("local creation");
      const version = (await remote(a)).globalVersion;
      await b.restart();
      await converged(a, b);
      expect(b.snapshot()).toEqual(snapshot);
      expect((await remote(a)).globalVersion).toBe(version);
    },
  );
});
