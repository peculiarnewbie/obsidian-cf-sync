export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export type MessageHandler = (msg: WSMessage) => void;
export type ConnectHandler = () => void;

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

  constructor(workerUrl: string, deviceToken: string, vaultId: string, deviceId: string) {
    const params = new URLSearchParams({ token: deviceToken, vaultId, deviceId });
    this.url = `${workerUrl.replace(/^http/, "ws")}/sync/ws?${params.toString()}`;
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
    if (this.ws?.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._connected = true;
      this.reconnectDelay = 1000;
      this.startPing();
      for (const handler of this.connectHandlers) {
        handler();
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WSMessage;
        for (const handler of this.handlers) {
          handler(msg);
        }
      } catch (e) {
        console.error("[ConnectionManager] WS message parse error:", e);
      }
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.stopPing();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this._connected = false;
      this.stopPing();
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this._connected = false;
    this.ws?.close();
    this.ws = null;
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
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }
}
