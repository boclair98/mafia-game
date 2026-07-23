"use client";

/**
 * Client-side game state: wire types + the interpolation buffer.
 *
 * The server broadcasts snapshots at a fixed 15 Hz (kept low because
 * WebSocket egress is billed by bytes — PLATFORM.md §5b), but the
 * canvas renders at 60+ fps. Drawing snapshots raw would look like a
 * slideshow, so we keep the last two and render the world one frame
 * "in the past", linearly interpolating between them — the standard
 * snapshot-interpolation trick.
 */

// ------------------------------------------------------- wire types
// Single-letter keys mirror the server (app/game.py) to keep frames small.

export type PlayerSnap = {
  id: string;
  n: string; // nick
  c: string; // color
  x: number;
  y: number;
  s: number; // score
};

export type StateMsg = {
  t: "state";
  players: PlayerSnap[];
  orbs: [number, number][];
};

export type WorldMeta = {
  size: number;
  player_r: number;
  orb_r: number;
  tick_hz: number;
};

export type WelcomeMsg = {
  t: "welcome";
  id: string;
  nick: string;
  signed_in: boolean;
  room: string;
  world: WorldMeta;
};

export type RenderPlayer = PlayerSnap;

export type RenderState = {
  players: RenderPlayer[];
  orbs: [number, number][];
};

// If an entity moved further than this between two snapshots it
// teleported (orb respawn, player spawn) — snap instead of gliding
// across the map.
const TELEPORT_PX = 300;

export class StateBuffer {
  private prev: { state: StateMsg; at: number } | null = null;
  private curr: { state: StateMsg; at: number } | null = null;

  push(state: StateMsg): void {
    this.prev = this.curr;
    this.curr = { state, at: performance.now() };
  }

  /** World as of `now`, lerped between the two latest snapshots. */
  sample(now: number): RenderState | null {
    if (!this.curr) return null;
    if (!this.prev) return this.curr.state;

    const span = this.curr.at - this.prev.at;
    // Render the *previous* snapshot's timeline position: alpha 0 → we
    // just received curr and draw prev; alpha 1 → we've caught up to
    // curr. Clamped so a late snapshot freezes instead of extrapolating.
    const alpha = span > 0 ? Math.min((now - this.curr.at) / span, 1) : 1;

    const prevPlayers = new Map(this.prev.state.players.map((p) => [p.id, p]));
    const players = this.curr.state.players.map((p) => {
      const q = prevPlayers.get(p.id);
      if (!q || Math.hypot(p.x - q.x, p.y - q.y) > TELEPORT_PX) return p;
      return {
        ...p,
        x: q.x + (p.x - q.x) * alpha,
        y: q.y + (p.y - q.y) * alpha,
      };
    });

    const prevOrbs = this.prev.state.orbs;
    const orbs = this.curr.state.orbs.map(([x, y], i): [number, number] => {
      const q = prevOrbs[i];
      if (!q || Math.hypot(x - q[0], y - q[1]) > TELEPORT_PX) return [x, y];
      return [q[0] + (x - q[0]) * alpha, q[1] + (y - q[1]) * alpha];
    });

    return { players, orbs };
  }
}
