import { test, expect, type Page } from "@playwright/test";
import type { GameState } from "../lib/game";

function observeGame(page: Page) {
  let state: GameState | null = null;
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    try {
      const message = JSON.parse(String(payload));
      if (message.t === "state") state = message;
    } catch { /* Ignore non-game frames. Resume keys are never logged. */ }
  }));
  return () => state;
}

async function dismissPhase(page: Page) {
  const button = page.getByRole("button", { name: "바로 플레이", exact: true });
  if (await button.isVisible()) await button.click();
}

async function joinFirstCase(page: Page, room: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "첫 사건 시작하기", exact: true }).click();
  await page.getByPlaceholder("게임에서 불릴 이름").fill("기록검사관");
  await page.locator(".room-field input").fill(room);
  await page.locator(".terms-check input").check();
  await page.locator(".join-enter-button").click();
  await expect(page.locator(".game-shell")).toBeVisible();
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test(`home, real font and keyboard modal ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.getByRole("button", { name: "첫 사건 시작하기", exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('15px "Pretendard"'))).toBe(true);
    await expectNoOverflow(page);
    if (viewport.width >= 1200) {
      const roomEntry = await page.getByRole("button", { name: "방 코드로 참가" }).boundingBox();
      expect(roomEntry).not.toBeNull();
      expect(roomEntry!.x + roomEntry!.width).toBeLessThan(viewport.width - 170);
    }
    await page.getByRole("button", { name: "첫 사건 시작하기", exact: true }).click();
    await expect(page.locator(".join-mode-picker button.first")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#join-room-help")).toContainText("첫 사건을 만들기 위한 코드");
    await expect(page.locator("#landing-nick")).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#landing-nick")).toBeFocused();
    await page.locator(".join-card button").first().focus();
    await page.keyboard.press("Shift+Tab");
    expect(await page.locator(".join-card").evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.locator(".join-card button").first()).toBeFocused();
    await page.getByRole("button", { name: "개인정보", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "개인정보 처리 안내" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "개인정보 처리 안내" })).not.toBeVisible();
    await expect(page.locator(".join-card")).toBeVisible();
    await expect(page.getByRole("button", { name: "개인정보", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".join-card")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "첫 사건 시작하기", exact: true })).toBeFocused();
    for (const key of ["Space", "Enter"]) {
      await page.keyboard.press(key);
      await expect(page.locator("#landing-nick")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator(".join-card")).not.toBeVisible();
    }
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await expectNoOverflow(page);
      expect(await page.locator("html").evaluate((element) => getComputedStyle(element).colorScheme)).toContain("dark");
    }
    expect(errors).toEqual([]);
    await page.screenshot({ path: `test-results/home-${viewport.width}.png`, fullPage: false });
  });
}

for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }]) {
  test(`mobile home entry paths remain touchable above the fixed utility zone ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const primary = page.getByRole("button", { name: "첫 사건 시작하기", exact: true });
    const shortcuts = page.getByRole("group", { name: "다른 플레이 방식" });
    await expect(primary).toBeVisible();
    await expect(shortcuts).toBeVisible();
    await expect(shortcuts.getByRole("button")).toHaveCount(3);
    await expectNoOverflow(page);

    const primaryBox = await primary.boundingBox();
    const shortcutButtons = await shortcuts.getByRole("button").all();
    expect(primaryBox?.height).toBeGreaterThanOrEqual(44);
    expect((primaryBox?.y ?? viewport.height) + (primaryBox?.height ?? 0)).toBeLessThan(viewport.height - 72);
    for (const button of shortcutButtons) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect((box?.y ?? viewport.height) + (box?.height ?? 0)).toBeLessThan(viewport.height - 72);
    }

    await shortcuts.getByRole("button", { name: "혼자 수사", exact: true }).click();
    await expect(page.locator(".join-mode-picker button.solo")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
    const footerAction = page.getByRole("button", { name: "설정·운영 정책", exact: true });
    const footerBox = await footerAction.boundingBox();
    expect(footerBox).not.toBeNull();
    expect(viewport.height - (footerBox!.y + footerBox!.height)).toBeGreaterThanOrEqual(72);
    await expectNoOverflow(page);
  });
}

test("rule preview waits for the player and supports manual steps on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "룰 미리보기" }).click();
  const title = page.locator(".tutorial-copy h2");
  await expect(title).toHaveText("밤에는 역할이 움직입니다");
  await page.waitForTimeout(7000);
  await expect(title).toHaveText("밤에는 역할이 움직입니다");
  const controls = page.locator(".tutorial-controls");
  await expect(controls.getByRole("button", { name: "다음 장면" })).toBeVisible();
  await controls.getByRole("button", { name: "다음 장면" }).click();
  await expect(title).toHaveText("단서는 범인을 포함합니다");
  await expect(controls.getByText("2 / 5번째 장면")).toHaveClass(/sr-only/);
  await controls.getByRole("button", { name: "5번째 장면 보기" }).click();
  await expect(title).toHaveText("모든 거짓말은 사건 파일에 남습니다");
  await expect(controls.getByRole("button", { name: "이전 장면" })).toBeVisible();
  await expect(controls.getByRole("button", { name: "안내 닫기" })).toBeVisible();
  expect(await controls.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/rule-preview-final-mobile.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".tutorial-film")).not.toBeVisible();
});

test("actual first case: finalized night -> cited question -> bot reply -> responsive records", async ({ page }) => {
  test.setTimeout(140_000);
  let droppedQuestion = false;
  await page.routeWebSocket(/\/api\/ws\?/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      try {
        if (!droppedQuestion && JSON.parse(String(message)).t === "challenge") {
          droppedQuestion = true; // Simulate one lost outbound command.
          return;
        }
      } catch { /* Forward other protocol frames unchanged. */ }
      server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });
  const current = observeGame(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const room = `first-e2e-${Date.now().toString(36)}`;
  await joinFirstCase(page, room);
  await expect.poll(() => current()?.phase, { timeout: 25_000 }).toBe("night");
  await dismissPhase(page);
  // The explicit local test runner seeds this first-case host as Mafia.
  // Production has no deterministic seed or shortened-clock switch.
  expect(current()?.me.role).toBe("mafia");
  const coach = page.getByTestId("first-case-coach");
  await expect(coach).toBeVisible();
  await expect(coach.locator("h2")).toHaveText("마피아: 밤의 능력을 선택하세요");
  await expect(coach).toContainText("마감 전에는 선택을 바꿀 수 있습니다.");
  await coach.getByRole("button", { name: "안내 접기" }).click();
  await expect(coach.getByRole("button", { name: "안내 열기" })).toHaveAttribute("aria-expanded", "false");
  await coach.getByRole("button", { name: "안내 열기" }).click();
  await expect(coach.locator("h2")).toBeVisible();
  const target = current()!.players.find((player) => player.bot && player.alive)!;
  await page.locator(".player-card").filter({ hasText: target.n }).click();
  await page.locator(".action-bar .seal-button").click();
  await expect.poll(() => current()?.me.action_target).toBe(target.id);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "게임 설정" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "게임 설정" })).not.toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  await page.screenshot({ path: "test-results/night-action.png", fullPage: false });
  await expect.poll(() => current()?.phase, { timeout: 25_000 }).toBe("day");
  await dismissPhase(page);
  await expect(coach.locator("h2")).toHaveText(/(지금은 당신의 집중 발언 차례예요|말과 기록이 어긋나는지 들어 보세요)/);
  // A real doctor bot may save the selected target; neither outcome is mocked.
  expect(["attack", "rescue"]).toContain(current()?.night_summary?.outcome);
  await expect(page.getByTestId("cross-examination-panel")).toBeVisible();
  await expect(page.locator(".cross-night-summary")).toContainText(current()!.night_summary!.title);
  await expect.poll(() => current()?.claims.some((claim) => claim.round === 1 && claim.speaker_id !== current()?.me.id), { timeout: 30_000 }).toBe(true);
  await page.locator("#challenge-question").fill("이 밤의 기록과 지금 진술을 함께 설명해 주세요.");
  await page.getByRole("button", { name: "기록을 제시해 질문", exact: true }).click();
  await expect(page.locator(".cross-feedback.error")).toContainText("접수 결과를 확인하지 못했습니다", { timeout: 16_000 });
  await expect(page.locator("#challenge-question")).toHaveValue("이 밤의 기록과 지금 진술을 함께 설명해 주세요.");
  expect(current()!.cross_examinations.filter((entry) => entry.asker_id === current()!.me.id)).toHaveLength(0);
  await page.getByRole("button", { name: "기록을 제시해 질문", exact: true }).click();
  await expect(page.locator(".cross-confirmed")).toBeVisible();
  await expect.poll(() => current()?.cross_examinations.find((entry) => entry.asker_id === current()?.me.id)?.response).toBeTruthy();
  await expect(page.locator(".cross-entry-response").first()).toBeVisible();
  const record = current()!.cross_examinations.find((entry) => entry.asker_id === current()!.me.id)!;
  expect(record.claim_text.length).toBeGreaterThan(0);
  expect(record.clue_detail.length).toBeGreaterThan(0);
  expect(record.response_kind).toMatch(/clarify|revise/);
  expect(current()?.night_replay).toEqual([]);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 1279) {
      const investigationTab = page.locator(".mobile-game-nav button").filter({ hasText: "수사" });
      await investigationTab.click();
      await expect(investigationTab).toHaveAttribute("aria-pressed", "true");
    }
    await expectNoOverflow(page);
    await page.locator(".cross-exam-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/case-${viewport.width}.png`, fullPage: false });
    const dock = page.locator(".mobile-command-dock");
    const box = await dock.boundingBox();
    if (box) expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  }
  await expect.poll(() => current()?.phase, { timeout: 50_000 }).toBe("vote");
  await page.setViewportSize({ width: 1440, height: 900 });
  await dismissPhase(page);
  const voteTarget = current()!.players.find((player) => player.bot && player.alive)!;
  await page.locator(".player-card").filter({ hasText: voteTarget.n }).click();
  await expect(page.locator(".action-bar .seal-button")).toBeEnabled();
  await page.screenshot({ path: "test-results/vote-1440.png", fullPage: false });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator(".mobile-command-dock button").filter({ hasText: "표 봉인" }).click();
  await expect.poll(() => current()?.me.vote_target).toBe(voteTarget.id);
  await expectNoOverflow(page);
  const flash = await page.locator(".decision-flash").boundingBox();
  const commandDock = await page.locator(".mobile-command-dock").boundingBox();
  if (flash && commandDock) expect(flash.y + flash.height).toBeLessThanOrEqual(commandDock.y);
  await page.screenshot({ path: "test-results/vote-360.png", fullPage: false });
  expect(errors).toEqual([]);
});

test("missing invite is an error with a recovery action", async ({ page }) => {
  await page.goto(`/?room=missing-e2e-${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "초대받은 사건에 합류", exact: true }).click();
  await page.getByPlaceholder("게임에서 불릴 이름").fill("복구검사관");
  await page.locator(".terms-check input").check();
  await page.locator(".join-enter-button").click();
  await expect(page.getByText("이 코드를 사용하는 방이 없습니다. 초대 코드나 링크를 확인해 주세요.", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".join-card")).toBeVisible();
  await expect(page.locator(".room-field input")).toHaveValue(/missing-e2e-/);
  await expect(page.locator(".join-enter-button")).toBeEnabled();
});

test("friend party: invite, readiness and shared game start", async ({ page, browser }) => {
  const hostState = observeGame(page);
  const room = `party-e2e-${Date.now().toString(36)}`;
  await page.goto("/");
  await page.getByRole("button", { name: /친구와 사건 시작/ }).click();
  await page.getByPlaceholder("게임에서 불릴 이름").fill("방장검사관");
  await page.locator(".room-field input").fill(room);
  await page.locator(".terms-check input").check();
  await page.locator(".join-enter-button").click();
  await expect.poll(() => hostState()?.phase).toBe("lobby");
  await page.locator(".bot-fill-switch button").filter({ hasText: /^4$/ }).click();
  await expect.poll(() => hostState()?.players.length).toBe(4);
  for (const viewport of [{width:1440,height:900},{width:768,height:1024},{width:390,height:844},{width:360,height:800}]) {
    await page.setViewportSize(viewport);
    await expectNoOverflow(page);
    expect(await page.locator(".game-shell").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator(".action-bar .start-game-button")).toBeEnabled();
    if (await page.locator(".action-bar .start-game-button").isVisible()) {
      const colors = await page.locator(".action-bar .start-game-button").evaluate((button) => ({button:getComputedStyle(button).color,label:getComputedStyle(button.querySelector("span")!).color}));
      expect(colors.label).toBe(colors.button);
    }
    await page.screenshot({ path: `test-results/party-${viewport.width}.png`, fullPage: false });
  }
  const guestContext = await browser.newContext({ viewport:{width:390,height:844}, serviceWorkers:"block" });
  try {
    const guest = await guestContext.newPage();
    const guestState = observeGame(guest);
    await guest.goto(`http://127.0.0.1:3100/?room=${room}`);
    await guest.getByRole("button", { name:"초대받은 사건에 합류", exact:true }).click();
    await guest.getByPlaceholder("게임에서 불릴 이름").fill("친구검사관");
    await guest.locator(".terms-check input").check();
    await guest.locator(".join-enter-button").click();
    await expect.poll(() => hostState()?.players.filter((player) => !player.bot).length).toBe(2);
    await expect(page.locator(".action-bar .start-game-button")).toBeDisabled();
    await guest.locator(".mobile-command-dock button").filter({hasText:"준비하기"}).click();
    await expect.poll(() => guestState()?.players.find((player) => player.id === guestState()?.me.id)?.ready).toBe(true);
    await page.setViewportSize({width:1440,height:900});
    await expect(page.locator(".action-bar .start-game-button")).toBeEnabled();
    await page.locator(".action-bar .start-game-button").click();
    await expect.poll(() => hostState()?.phase).toBe("reveal");
    await expect.poll(() => guestState()?.phase).toBe("reveal");
  } finally { await guestContext.close(); }
});
