"use client";

/** Reconnect the same seat; gameplay commands are never queued or replayed. */

export type ConnStatus = "connecting" | "open" | "reconnecting" | "failed";

const PING_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
// A cold-started API can take roughly 30 seconds to accept its first socket.
// Keep the initial window generous, but never leave the lobby spinner waiting
// forever when a proxy or websocket upgrade is genuinely unavailable.
const CONNECT_TIMEOUT_MS = 45_000;

export function gameSocketUrl(room: string, nick: string, key: string, joinOnly = false): string {
  const query = `room=${encodeURIComponent(room)}&nick=${encodeURIComponent(nick)}&key=${encodeURIComponent(key)}${joinOnly ? "&join_only=true" : ""}`;
  // `next dev` can't proxy WebSockets (PLATFORM.md), so in local dev we
  // hit the backend's published port directly. In production nginx
  // proxies /api/ws on this same origin with Upgrade headers.
  if (process.env.NODE_ENV === "development") {
    return `ws://${location.hostname}:8000/api/ws?${query}`;
  }
  if (location.hostname === "localhost") {
    return `wss://black-midnight.coders.kr/api/ws?${query}`;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/ws?${query}`;
}

type Handlers = {
  onMessage: (msg: unknown) => void;
  onStatus: (status: ConnStatus) => void;
  onFatal?: (reason: "room_full" | "solo_room" | "removed_by_host" | "server_busy" | "room_not_found" | "session_replaced" | "seat_unauthorized") => void;
};

export class GameSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closed = false;
  private connectedOnce = false;
  private lastReceivedAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: Handlers
  ) {
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.wake);
      window.addEventListener("offline", this.offline);
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.wake);
    this.connect();
  }

  /** Returns false when the caller needs to keep the user's input visible
   *  and ask them to retry after the connection recovers. */
  send(msg: object): boolean {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; }
    catch { this.restart(); return false; }
  }

  retry(): void { if (!this.closed) this.restart(); }

  close(): void {
    this.closed = true;
    this.clearTimers();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.wake);
      window.removeEventListener("offline", this.offline);
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.wake);
    const old = this.ws;
    this.ws = null;
    old?.close();
  }

  private networkOnline(): boolean { return typeof navigator === "undefined" || navigator.onLine !== false; }

  private offline = (): void => {
    if (this.closed) return;
    this.handlers.onStatus("reconnecting");
    this.clearTimers();
    const old = this.ws;
    this.ws = null;
    old?.close();
  };

  private wake = (): void => {
    if (this.closed || !this.networkOnline() || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastReceivedAt < PING_INTERVAL_MS) {
      this.send({ t: "ping" });
      return;
    }
    this.restart();
  };

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.pingTimer = this.reconnectTimer = this.connectTimer = null;
  }

  private restart(): void {
    if (this.closed) return;
    this.clearTimers();
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.handlers.onStatus("reconnecting");
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.handlers.onStatus(this.connectedOnce || this.attempts > 0 ? "reconnecting" : "connecting");
    if (!this.networkOnline()) return;
    const ws = (this.ws = new WebSocket(this.url));
    this.connectTimer = setTimeout(() => {
      if (!this.closed && this.ws === ws) this.restart();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.closed || this.ws !== ws) return;
      this.lastReceivedAt = Date.now();
      // An upgraded TCP connection is not yet an authoritative recovered game.
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.closed || this.ws !== ws) return;
        if (Date.now() - this.lastReceivedAt >= HEARTBEAT_TIMEOUT_MS) this.restart();
        else this.send({ t: "ping" });
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      if (this.closed || this.ws !== ws) return;
      let message: unknown;
      try { message = JSON.parse(ev.data); } catch { return; }
      this.lastReceivedAt = Date.now();
      if (message && typeof message === "object" && "t" in message && message.t === "state") {
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.attempts = 0;
        this.connectedOnce = true;
        this.handlers.onStatus("open");
      }
      this.handlers.onMessage(message);
    };

    // onerror always precedes onclose; reconnect logic lives in one place.
    ws.onclose = (event) => {
      if (this.closed || this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if ([4001, 4003, 4004, 4005, 4006, 4007, 4009].includes(event.code)) {
        this.close();
        this.handlers.onStatus("failed");
        this.handlers.onFatal?.(
          event.code === 4009
            ? "seat_unauthorized"
            : event.code === 4001
            ? "session_replaced"
            : event.code === 4007
              ? "room_not_found"
              : event.code === 4004
            ? "room_full"
            : event.code === 4005
              ? "solo_room"
              : event.code === 4006
                ? "server_busy"
                : "removed_by_host"
        );
        return;
      }
      this.handlers.onStatus("reconnecting");
      if (!this.networkOnline()) return;
      // Exponential backoff with jitter so a fleet of clients doesn't
      // stampede the pod that just came back.
      const delay =
        Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.attempts, 10)) *
        (0.5 + Math.random() / 2);
      this.attempts += 1;
      // 4008 is a retryable durable-runtime/room handoff, not a missing room.
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    };
  }
}
