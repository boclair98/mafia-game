"use client";

/**
 * The fullscreen arena canvas: rendering + input capture.
 *
 * Rendering runs in a requestAnimationFrame loop that samples the
 * StateBuffer (lib/game.ts) — React never re-renders per frame; all
 * mutable per-frame data flows through refs.
 *
 * Input is *intent only*: we reduce keyboard (WASD/arrows) and pointer
 * (hold/drag = virtual stick from screen center) to one normalized
 * direction vector and hand it to `onInput`, which sends it to the
 * server. The server integrates movement — the client never reports a
 * position, so it can't lie about one.
 */

import { useEffect, useRef } from "react";

import type { StateBuffer, WorldMeta } from "@/lib/game";

type Props = {
  buffer: StateBuffer;
  meta: WorldMeta | null;
  selfId: string | null;
  onInput: (dx: number, dy: number) => void;
};

const KEY_DIRS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const POINTER_DEADZONE_PX = 24;

export function GameCanvas({ buffer, meta, selfId, onInput }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Latest props, readable from inside the rAF loop without re-binding it.
  const liveRef = useRef({ meta, selfId, onInput });
  useEffect(() => {
    liveRef.current = { meta, selfId, onInput };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // ---------------------------------------------------------- sizing
    // Track the element's CSS size × devicePixelRatio so the world is
    // crisp on retina displays and survives window resizes / rotation.
    let width = 0;
    let height = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // ----------------------------------------------------------- input
    const held = new Set<string>();
    let pointer: { x: number; y: number } | null = null;
    let lastSent = { dx: NaN, dy: NaN };

    const currentDir = (): [number, number] => {
      // Pointer wins while held (mobile); else sum the held keys.
      if (pointer) {
        const dx = pointer.x - width / 2;
        const dy = pointer.y - height / 2;
        const mag = Math.hypot(dx, dy);
        if (mag < POINTER_DEADZONE_PX) return [0, 0];
        return [dx / mag, dy / mag];
      }
      let dx = 0;
      let dy = 0;
      for (const code of held) {
        const d = KEY_DIRS[code];
        dx += d[0];
        dy += d[1];
      }
      const mag = Math.hypot(dx, dy);
      return mag > 0 ? [dx / mag, dy / mag] : [0, 0];
    };

    const pushInput = () => {
      const [dx, dy] = currentDir();
      // The server keeps the last intent, so only changes need sending.
      if (dx === lastSent.dx && dy === lastSent.dy) return;
      lastSent = { dx, dy };
      liveRef.current.onInput(dx, dy);
    };

    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (!(e.code in KEY_DIRS)) return;
      e.preventDefault();
      if (down) held.add(e.code);
      else held.delete(e.code);
      pushInput();
    };
    const keyDown = onKey(true);
    const keyUp = onKey(false);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);

    const toLocal = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const pointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointer = toLocal(e);
      pushInput();
    };
    const pointerMove = (e: PointerEvent) => {
      if (pointer) {
        pointer = toLocal(e);
        pushInput();
      }
    };
    const pointerEnd = () => {
      pointer = null;
      pushInput();
    };
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerEnd);
    canvas.addEventListener("pointercancel", pointerEnd);

    // ------------------------------------------------------ render loop
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { meta, selfId } = liveRef.current;

      ctx.fillStyle = "#0b0f1a";
      ctx.fillRect(0, 0, width, height);

      const state = buffer.sample(performance.now());
      if (!meta || !state) return; // still connecting — Hud says so

      // Camera: follow our player (fall back to world center), clamped
      // to the world unless the viewport is bigger than the world.
      const me = state.players.find((p) => p.id === selfId);
      const clampCam = (c: number, view: number) =>
        view >= meta.size
          ? meta.size / 2
          : Math.min(Math.max(c, view / 2), meta.size - view / 2);
      const camX = clampCam(me ? me.x : meta.size / 2, width);
      const camY = clampCam(me ? me.y : meta.size / 2, height);

      ctx.save();
      ctx.translate(width / 2 - camX, height / 2 - camY);

      // Grid + world edge, so motion is visible even with no one nearby.
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      const grid = 100;
      ctx.beginPath();
      for (let g = 0; g <= meta.size; g += grid) {
        ctx.moveTo(g, 0);
        ctx.lineTo(g, meta.size);
        ctx.moveTo(0, g);
        ctx.lineTo(meta.size, g);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(148,163,184,0.5)";
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, meta.size, meta.size);

      // Orbs: soft halo + bright core.
      for (const [x, y] of state.orbs) {
        ctx.fillStyle = "rgba(251,191,36,0.15)";
        ctx.beginPath();
        ctx.arc(x, y, meta.orb_r * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fbbf24";
        ctx.beginPath();
        ctx.arc(x, y, meta.orb_r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Players: filled circle, white ring on yours, nick + score above.
      for (const p of state.players) {
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, meta.player_r, 0, Math.PI * 2);
        ctx.fill();
        if (p.id === selfId) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font = "12px var(--font-sans-stack, sans-serif)";
        ctx.textAlign = "center";
        ctx.fillText(`${p.n} · ${p.s}`, p.x, p.y - meta.player_r - 8);
      }

      ctx.restore();
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerEnd);
      canvas.removeEventListener("pointercancel", pointerEnd);
    };
  }, [buffer]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none select-none"
      aria-label="game arena"
    />
  );
}
