import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../connection";

class FakeWebSocket {
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  send(): void {}
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectionManager", () => {
  it("does not reconnect after an intentional disconnect", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const connection = new ConnectionManager(
      "https://sync.example.com",
      "device-token",
      "personal",
      "desktop-a",
      () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );

    connection.connect();
    connection.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sockets).toHaveLength(1);
    expect(connection.connected).toBe(false);
  });

  it("does not create duplicate sockets while a connection is opening", () => {
    const sockets: FakeWebSocket[] = [];
    const connection = new ConnectionManager(
      "https://sync.example.com",
      "device-token",
      "personal",
      "desktop-a",
      () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );

    connection.connect();
    connection.connect();

    expect(sockets).toHaveLength(1);
    connection.disconnect();
  });
});
