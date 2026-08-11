"use client";

/**
 * A reconnecting WebSocket for the game.
 *
 * On this platform a dropped socket is NORMAL, not exceptional
 * (PLATFORM.md §5a): Spot-node preemption, a redeploy rolling the
 * revision, and idle scale-to-zero all sever open connections. So
 * reconnect-with-backoff is the core of this class, not an
 * afterthought — the server treats every (re)connect as a fresh join
 * and the next state snapshot repaints the whole world, so there's no
 * session to resume.
 *
 * Keepalive: an app-level {"t":"ping"} every 20s keeps intermediaries
 * from reaping a quiet socket. Idle WebSockets are ~free (billed by
 * egress bytes, not open-time — §5b), so this costs nothing real.
 */

export type ConnStatus = "connecting" | "open" | "reconnecting";

const PING_INTERVAL_MS = 20_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

export function gameSocketUrl(room: string, nick: string, key: string): string {
  const query = `room=${encodeURIComponent(room)}&nick=${encodeURIComponent(nick)}&key=${encodeURIComponent(key)}`;
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
};

export class GameSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: Handlers
  ) {
    this.connect();
  }

  /** Send a JSON message; silently dropped unless the socket is open
   *  (a lost input during a reconnect gap doesn't matter — the client
   *  keeps sending fresh intent). */
  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    this.handlers.onStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = (this.ws = new WebSocket(this.url));

    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onStatus("open");
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(
        () => this.send({ t: "ping" }),
        PING_INTERVAL_MS
      );
    };

    ws.onmessage = (ev) => {
      try {
        this.handlers.onMessage(JSON.parse(ev.data));
      } catch {
        /* non-JSON frame — ignore */
      }
    };

    // onerror always precedes onclose; reconnect logic lives in one place.
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.closed) return;
      this.handlers.onStatus("reconnecting");
      // Exponential backoff with jitter so a fleet of clients doesn't
      // stampede the pod that just came back.
      const delay =
        Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempts) *
        (0.5 + Math.random() / 2);
      this.attempts += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }
}
