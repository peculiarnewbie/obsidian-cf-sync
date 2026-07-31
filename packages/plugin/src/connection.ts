export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export type MessageHandler = (msg: WSMessage) => void;
export type ConnectHandler = () => void;
type WebSocketFactory = (url: string) => WebSocket;

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: MessageHandler[] = [];
  private connectHandlers: ConnectHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private _connected = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = false;
  private createWebSocket: WebSocketFactory;

  constructor(
    workerUrl: string,
    deviceToken: string,
    vaultId: string,
    deviceId: string,
    createWebSocket: WebSocketFactory = (url) => new WebSocket(url),
  ) {
    const params = new URLSearchParams({ token: deviceToken, vaultId, deviceId });
    this.url = `${workerUrl.replace(/^http/, "ws")}/sync/ws?${params.toString()}`;
    this.createWebSocket = createWebSocket;
  }

  get connected(): boolean {
    return this._connected;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  onConnect(handler: ConnectHandler): void {
    this.connectHandlers.push(handler);
  }

  connect(): void {
    this.shouldReconnect = true;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = this.createWebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket || !this.shouldReconnect) {
        socket.close();
        return;
      }
      this._connected = true;
      this.reconnectDelay = 1000;
      this.startPing();
      for (const handler of this.connectHandlers) {
        handler();
      }
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket || !this.shouldReconnect) return;
      try {
        const msg = JSON.parse(event.data as string) as WSMessage;
        for (const handler of this.handlers) {
          handler(msg);
        }
      } catch (e) {
        console.error("[ConnectionManager] WS message parse error:", e);
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this._connected = false;
      this.stopPing();
      if (this.shouldReconnect) this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      this._connected = false;
      this.stopPing();
      socket.close();
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this._connected = false;
    const socket = this.ws;
    this.ws = null;
    socket?.close();
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }
}
