import { test, expect, type Page } from "@playwright/test";
import type { GameState } from "../lib/game";

test.use({ trace: "off" });

type InstrumentedWindow = Window & {
  __qaVoicePeers: RTCPeerConnection[];
  __qaGameSockets: WebSocket[];
};

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const debug = window as unknown as InstrumentedWindow;
    debug.__qaVoicePeers = [];
    debug.__qaGameSockets = [];
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        debug.__qaVoicePeers.push(this);
      }
    };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        debug.__qaGameSockets.push(this);
      }
    };
  });
}

function observe(page: Page) {
  let state: GameState | undefined;
  let welcomes = 0;
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    try {
      const message = JSON.parse(String(payload));
      if (message.t === "state") state = message;
      if (message.t === "welcome") welcomes += 1;
    } catch { /* Synthetic QA packets only; never print frames or seat keys. */ }
  }));
  return { state: () => state, welcomes: () => welcomes };
}

async function incomingAudioBytes(page: Page) {
  return page.evaluate(async () => {
    const debug = window as unknown as InstrumentedWindow;
    let total = 0;
    for (const peer of debug.__qaVoicePeers) {
      if (peer.connectionState !== "connected") continue;
      const stats = await peer.getStats();
      stats.forEach(entry => {
        if (entry.type === "inbound-rtp" && (entry.kind === "audio" || entry.mediaType === "audio")) total += entry.bytesReceived || 0;
      });
    }
    return total;
  });
}

async function unblockedPlayback(page: Page) {
  const unlock = page.getByTestId("voice-unlock");
  if (await unlock.isVisible()) await unlock.click();
  await expect(unlock).toBeHidden();
}

test("two synthetic microphones receive RTP and recover muted voice intent", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const hostContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, permissions: ["microphone"], serviceWorkers: "block" });
  const guestContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, permissions: ["microphone"], serviceWorkers: "block" });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const errors: string[] = [];
  host.on("pageerror", error => errors.push(error.message));
  guest.on("pageerror", error => errors.push(error.message));
  const hostGame = observe(host);
  const guestGame = observe(guest);
  await instrument(host);
  await instrument(guest);
  const room = `party-voice-e2e-${Date.now().toString(36)}`;
  try {
    await host.goto("/");
    await host.getByRole("button", { name: /친구와 사건 시작/ }).click();
    await host.getByPlaceholder("게임에서 불릴 이름").fill("음성검사관A");
    await host.locator(".room-field input").fill(room);
    await host.locator(".terms-check input").check();
    await host.locator(".join-enter-button").click();
    await expect(host.locator(".game-shell")).toBeVisible();
    await guest.goto(`/?room=${room}`);
    await guest.getByRole("button", { name: "초대받은 사건에 합류", exact: true }).click();
    await guest.getByPlaceholder("게임에서 불릴 이름").fill("음성검사관B");
    await guest.locator(".terms-check input").check();
    await guest.locator(".join-enter-button").click();
    await expect(guest.locator(".game-shell")).toBeVisible();
    await expect.poll(() => hostGame.state()?.players.filter(player => !player.bot).length).toBe(2);
    await host.getByRole("button", { name: "음성 참여", exact: true }).click();
    await guest.getByRole("button", { name: "음성 참여", exact: true }).click();
    await expect(host.getByTestId("voice-status")).toHaveAttribute("data-connected-peers", "1", { timeout: 30_000 });
    await expect(guest.getByTestId("voice-status")).toHaveAttribute("data-connected-peers", "1", { timeout: 30_000 });
    await expect.poll(() => incomingAudioBytes(host), { timeout: 20_000 }).toBeGreaterThan(100);
    await expect.poll(() => incomingAudioBytes(guest), { timeout: 20_000 }).toBeGreaterThan(100);
    await unblockedPlayback(host);
    await unblockedPlayback(guest);

    for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
      await host.setViewportSize(viewport);
      if (viewport.width < 1280) await host.locator(".mobile-game-nav button").filter({ hasText: "대화" }).click();
      await host.getByTestId("voice-status").scrollIntoViewIfNeeded();
      expect(await host.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await host.screenshot({ path: `test-results/voice-connected-${viewport.width}.png`, fullPage: false });
    }

    await host.getByRole("button", { name: "마이크 끄기", exact: true }).click();
    await expect(host.getByRole("button", { name: "마이크 켜기", exact: true })).toHaveAttribute("aria-pressed", "false");
    await hostContext.setOffline(true);
    await host.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(host.getByTestId("voice-status")).toHaveAttribute("data-connected-peers", "0");
    await hostContext.setOffline(false);
    await host.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => hostGame.welcomes(), { timeout: 30_000 }).toBeGreaterThan(1);
    // Lobby disconnects release a seat by design. Active-game seat identity is
    // verified separately by the real process-kill recovery tool.
    await expect.poll(() => hostGame.state()?.players.filter(player => player.n === "음성검사관A").length).toBe(1);
    await expect(host.getByTestId("voice-status")).toHaveAttribute("data-connected-peers", "1", { timeout: 30_000 });
    await expect(host.getByRole("button", { name: "마이크 켜기", exact: true })).toHaveAttribute("aria-pressed", "false");
    expect(await host.evaluate(() => (window as unknown as InstrumentedWindow).__qaVoicePeers.filter(peer => peer.connectionState === "connected").every(peer => peer.getSenders().every(sender => !sender.track || !sender.track.enabled)))).toBe(true);
    await expect.poll(() => incomingAudioBytes(host), { timeout: 15_000 }).toBeGreaterThan(100);
    await unblockedPlayback(host);
    await host.getByTestId("voice-retry").click();
    await expect(host.getByTestId("voice-status")).toHaveAttribute("data-connected-peers", "1", { timeout: 30_000 });
    expect(guestGame.state()?.players.some(player => player.id === hostGame.state()?.me.id)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
