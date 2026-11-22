import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/ws.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const { GameSocket } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

function environment(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  t.mock.method(Math, "random", () => 1);
  const sockets = [], statuses = [], messages = [], fatal = [];
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    send(payload) { this.sent.push(JSON.parse(payload)); }
    close() { this.readyState = 3; }
    serverClose(code) { this.readyState = 3; this.onclose?.({ code }); }
  }
  globalThis.WebSocket = Socket;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  document.visibilityState = "visible";
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
  const game = new GameSocket("ws://127.0.0.1/room?key=synthetic", { onStatus: (status) => statuses.push(status), onMessage: (message) => messages.push(message), onFatal: (reason) => fatal.push(reason) });
  t.after(() => game.close());
  return { game, sockets, statuses, messages, fatal };
}

test("TCP upgrade is not game recovery; the first authoritative snapshot marks it open", (t) => {
  const { game, sockets, statuses } = environment(t);
  sockets[0].open();
  assert.equal(statuses.at(-1), "connecting");
  sockets[0].message({ t: "welcome", resumed: true });
  assert.equal(statuses.at(-1), "connecting");
  sockets[0].message({ t: "state" });
  assert.equal(statuses.at(-1), "open");
  t.mock.timers.tick(20000);
  assert.deepEqual(sockets[0].sent.at(-1), { t: "ping" });
  sockets[0].message({ t: "pong" });
  t.mock.timers.tick(20000);
  assert.equal(sockets.length, 1);
  game.close();
});

test("a half-open transport is replaced without replaying unsent decisions", (t) => {
  const { game, sockets, statuses } = environment(t);
  sockets[0].open(); sockets[0].message({ t: "state" });
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 2);
  assert.equal(statuses.at(-1), "reconnecting");
  assert.equal(game.send({ t: "vote", target: "synthetic" }), false);
  sockets[1].open(); sockets[1].message({ t: "state" });
  assert.deepEqual(sockets[1].sent, []);
  assert.equal(sockets[1].url, sockets[0].url, "resume must preserve the seat key and room");
});

test("stale open/message/close events cannot alter the replacement or cancel its heartbeat", (t) => {
  const { game, sockets, messages, statuses } = environment(t);
  sockets[0].open(); sockets[0].message({ t: "state" });
  game.retry();
  sockets[1].open(); sockets[1].message({ t: "state" });
  const count = messages.length;
  sockets[0].open(); sockets[0].message({ t: "state", stale: true }); sockets[0].serverClose(4001);
  assert.equal(messages.length, count);
  assert.equal(statuses.at(-1), "open");
  t.mock.timers.tick(20000);
  assert.deepEqual(sockets[1].sent, [{ t: "ping" }]);
});

test("4008 runtime recovery is retryable and rejected upgrades do not reset exponential backoff", (t) => {
  const { sockets, fatal } = environment(t);
  sockets[0].open(); sockets[0].serverClose(4008);
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);
  sockets[1].open(); sockets[1].serverClose(4008);
  t.mock.timers.tick(999);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 3);
  assert.deepEqual(fatal, []);
});

test("offline waits for an online event; explicit close removes wake listeners", (t) => {
  const { game, sockets } = environment(t);
  sockets[0].open(); sockets[0].message({ t: "state" });
  navigator.onLine = false;
  window.dispatchEvent(new Event("offline"));
  t.mock.timers.tick(120000);
  assert.equal(sockets.length, 1);
  navigator.onLine = true;
  window.dispatchEvent(new Event("online"));
  assert.equal(sockets.length, 2);
  game.close();
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(120000);
  assert.equal(sockets.length, 2);
});

test("returning from a suspended tab refreshes stale state; replacement-session close remains terminal", (t) => {
  const { sockets, fatal, statuses } = environment(t);
  sockets[0].open(); sockets[0].message({ t: "state" });
  t.mock.timers.setTime(90000);
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(sockets.length, 2);
  sockets[1].serverClose(4001);
  assert.deepEqual(fatal, ["session_replaced"]);
  t.mock.timers.tick(120000);
  assert.equal(sockets.length, 2);
  assert.equal(statuses.at(-1), "failed");
});

test("a signed-in seat ownership rejection is terminal and never rotates the resume key", (t) => {
  const { sockets, fatal, statuses } = environment(t);
  sockets[0].serverClose(4009);
  assert.deepEqual(fatal, ["seat_unauthorized"]);
  assert.equal(statuses.at(-1), "failed");
  t.mock.timers.tick(120000);
  assert.equal(sockets.length, 1);
});
