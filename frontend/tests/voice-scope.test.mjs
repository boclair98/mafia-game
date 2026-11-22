import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/voice.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { VoiceRoom } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

function browser() {
  const peers = [];
  const audio = [];
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let offerGate = null;
  let playbackDenied = false;
  let incomingBytes = 0;
  class Peer {
    constructor(configuration) { this.configuration = configuration; this.remoteDescription = null; this.ice = []; this.closed = false; this.signalingState = "stable"; this.connectionState = "new"; this.offers = []; this.restarts = 0; peers.push(this); }
    addTrack() {}
    async createOffer(options) { this.offers.push(options); if (offerGate) await offerGate; return { type: "offer", sdp: "mock-offer" }; }
    async createAnswer() { return { type: "answer", sdp: "mock-answer" }; }
    async setLocalDescription(description) { this.localDescription = description; this.signalingState = description.type === "offer" ? "have-local-offer" : "stable"; }
    async setRemoteDescription(description) { this.remoteDescription = description; this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable"; }
    async addIceCandidate(candidate) { this.ice.push(candidate); }
    setConfiguration(configuration) { this.configuration = configuration; }
    restartIce() { this.restarts += 1; }
    async getStats() { return new Map([["audio", { type: "inbound-rtp", kind: "audio", bytesReceived: incomingBytes }]]); }
    getReceivers() { return []; }
    close() { this.closed = true; this.connectionState = "closed"; }
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  globalThis.RTCPeerConnection = Peer;
  globalThis.document = { createElement: () => {
    const element = { srcObject: null, paused: false, async play() { if (playbackDenied) throw new Error("autoplay"); }, pause() { this.paused = true; } };
    audio.push(element);
    return element;
  } };
  return { peers, audio, track, deferOffer: (promise) => { offerGate = promise; }, denyPlayback: (value) => { playbackDenied = value; }, receive: (bytes) => { incomingBytes = bytes; } };
}

test("scope change revokes peers, audio and microphone; stale and unauthorized signals stay closed", async () => {
  const env = browser();
  const sent = [];
  const room = new VoiceRoom("a", (...signal) => sent.push(signal), () => {});
  await room.start();
  assert.equal(env.track.enabled, false, "capture starts muted until server authorization");
  await room.syncPeers("1:table", ["b"]);
  room.setMicEnabled(true);
  env.peers[0].ontrack({ streams: [{}] });
  assert.ok(env.audio[0].srcObject);
  room.configureScope("2:mafia", []);
  assert.equal(env.peers[0].closed, true);
  assert.equal(env.peers[0].onicecandidate, null);
  assert.equal(env.audio[0].paused, true);
  assert.equal(env.audio[0].srcObject, null);
  assert.equal(env.track.enabled, false);
  await room.handleSignal("b", { kind: "description", description: { type: "offer" } }, "1:table");
  await room.handleSignal("intruder", { kind: "description", description: { type: "offer" } }, "2:mafia");
  assert.equal(env.peers.length, 1, "revoked signals must not create a connection");
  assert.equal(sent.length, 1);
  room.stop();
  assert.equal(env.track.stopped, true);
});

test("an offer finishing after a generation change cannot send or close its replacement", async () => {
  const env = browser();
  const sent = [];
  let release;
  env.deferOffer(new Promise((resolve) => { release = resolve; }));
  const room = new VoiceRoom("a", (...signal) => sent.push(signal), () => {});
  await room.start();
  const pending = room.syncPeers("3:table", ["b"]);
  room.configureScope("4:table", ["b"]);
  env.deferOffer(null);
  await room.syncPeers("4:table", ["b"]);
  release();
  await pending;
  assert.equal(env.peers[0].closed, true);
  assert.equal(env.peers[1].closed, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][2], "4:table");
  room.stop();
});

test("ICE queues are bounded and only the authorized current scope produces an answer", async () => {
  const env = browser();
  const sent = [];
  const room = new VoiceRoom("z", (...signal) => sent.push(signal), () => {});
  await room.start();
  room.configureScope("8:ghost", ["b"]);
  for (let i = 0; i < 100; i++) {
    await room.handleSignal("b", { kind: "candidate", candidate: { candidate: `mock-${i}` } }, "8:ghost");
  }
  await room.handleSignal("b", { kind: "description", description: { type: "offer" } }, "8:ghost");
  assert.equal(env.peers[0].ice.length, 64);
  assert.equal(sent[0][1].description.type, "answer");
  assert.equal(sent[0][2], "8:ghost");
  room.configureScope(null, []);
  room.setMicEnabled(true);
  assert.equal(env.track.enabled, false, "no active channel must remain muted");
  room.stop();
  await room.handleSignal("b", { kind: "description", description: { type: "offer" } }, "8:ghost");
  assert.equal(env.peers.length, 1);
});

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("a transient disconnect has a grace period, then restarts ICE; scope revocation cancels recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  const env = browser(), sent = [];
  const room = new VoiceRoom("a", (...value) => sent.push(value), () => {});
  t.after(() => room.stop());
  await room.start();
  await room.syncPeers("9:table", ["b"]);
  const peer = env.peers[0];
  await room.handleSignal("b", { kind: "description", description: { type: "answer" } }, "9:table");
  peer.connectionState = "connected";
  peer.onconnectionstatechange();
  peer.connectionState = "disconnected";
  peer.onconnectionstatechange();
  t.mock.timers.tick(2999);
  assert.equal(peer.restarts, 0);
  t.mock.timers.tick(1);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(peer.restarts, 1);
  assert.equal(peer.offers.at(-1).iceRestart, true);
  room.configureScope(null, []);
  const count = sent.length;
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(sent.length, count, "revoked timers must not negotiate in an old channel");
});

test("recovery is bounded, exposes failure, and explicit retry works for the answering peer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  const env = browser(), states = [], errors = [], sent = [];
  const room = new VoiceRoom("z", (...value) => sent.push(value), (error) => errors.push(error), (state) => states.push(state));
  t.after(() => room.stop());
  await room.start();
  room.configureScope("10:table", ["a"]);
  await room.handleSignal("a", { kind: "description", description: { type: "offer" } }, "10:table");
  env.peers[0].connectionState = "failed";
  env.peers[0].onconnectionstatechange();
  for (let second = 0; second < 90 && states.at(-1)?.state !== "failed"; second++) {
    t.mock.timers.tick(1000);
    await flush();
  }
  assert.equal(states.at(-1).state, "failed");
  assert.equal(errors.length, 1);
  const attempts = env.peers.length;
  t.mock.timers.tick(120000); await flush();
  assert.equal(env.peers.length, attempts, "failed peers must not spin forever");
  await room.retry();
  assert.equal(env.peers.length, attempts + 1);
  assert.equal(sent.at(-1)[1].description.type, "offer", "the polite answering side can initiate manual recovery");
});

test("glare ignores an impolite collision and accepts a polite collision without leaking scope", async () => {
  let env = browser();
  const sent = [];
  let room = new VoiceRoom("a", (...value) => sent.push(value), () => {});
  await room.start();
  await room.syncPeers("11:table", ["b"]);
  await room.handleSignal("b", { kind: "description", description: { type: "offer" } }, "11:table");
  assert.equal(env.peers[0].remoteDescription, null, "impolite peer keeps its outstanding local offer");
  await room.handleSignal("b", { kind: "candidate", candidate: { candidate: "ignored" } }, "11:table");
  assert.equal(env.peers[0].ice.length, 0);
  await room.handleSignal("b", { kind: "description", description: { type: "answer" } }, "11:table");
  assert.equal(env.peers[0].remoteDescription.type, "answer");
  room.stop();
  env = browser();
  room = new VoiceRoom("z", (...value) => sent.push(value), () => {});
  await room.start();
  room.configureScope("12:table", ["a"]);
  await room.retry();
  await room.handleSignal("a", { kind: "description", description: { type: "offer" } }, "12:table");
  assert.equal(env.peers[0].remoteDescription.type, "offer");
  assert.equal(sent.at(-1)[1].description.type, "answer");
  room.stop();
});

test("autoplay recovery is explicit and received audio statistics are separate from peer presence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  const env = browser(), states = [];
  const room = new VoiceRoom("a", () => {}, () => {}, (state) => states.push(state));
  t.after(() => room.stop());
  await room.start();
  await room.syncPeers("13:table", ["b"]);
  env.denyPlayback(true);
  env.peers[0].ontrack({ streams: [{}] });
  await flush();
  assert.equal(states.at(-1).playbackBlocked, true);
  env.denyPlayback(false);
  await room.resumePlayback();
  assert.equal(states.at(-1).playbackBlocked, false);
  env.peers[0].connectionState = "connected";
  env.peers[0].onconnectionstatechange();
  assert.equal(states.at(-1).connectedPeers, 1);
  assert.equal(states.at(-1).receivingPeers, 0);
  env.receive(128);
  t.mock.timers.tick(3000); await flush();
  assert.equal(states.at(-1).receivingPeers, 1);
  t.mock.timers.tick(3000); await flush();
  assert.equal(states.at(-1).receivingPeers, 0, "a connected peer is not evidence of continuously received packets");
});

test("short-lived ICE configuration refresh is cancelled when leaving voice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  const env = browser();
  let requests = 0;
  const room = new VoiceRoom("a", () => {}, () => {}, () => {}, () => { requests += 1; });
  await room.start();
  room.configureIce({ t: "voice_config", ice_servers: [{ urls: "turn:relay.invalid:3478", username: "test", credential: "synthetic" }], relay_configured: true, expires_at: Date.now() + 120000 });
  await room.syncPeers("14:table", ["b"]);
  assert.equal(env.peers[0].configuration.iceServers[0].urls, "turn:relay.invalid:3478");
  t.mock.timers.tick(60000); await flush();
  assert.ok(requests >= 2);
  room.stop();
  const count = requests;
  t.mock.timers.tick(120000); await flush();
  assert.equal(requests, count);
});

test("scope change during an awaited multi-peer sync or retry never creates the remaining revoked peers", async () => {
  for (const retry of [false, true]) {
    const env = browser();
    let release;
    env.deferOffer(new Promise((resolve) => { release = resolve; }));
    const room = new VoiceRoom("a", () => {}, () => {});
    await room.start();
    room.configureScope("15:table", ["b", "c"]);
    const pending = retry ? room.retry() : room.syncPeers("15:table", ["b", "c"]);
    room.configureScope(null, []);
    release();
    await pending;
    assert.equal(env.peers.length, 1);
    assert.equal(env.peers[0].closed, true);
    assert.equal(env.track.enabled, false);
    room.stop();
  }
});

test("a queued watchdog does not restart a transport that is already connected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  const env = browser();
  const room = new VoiceRoom("a", () => {}, () => {});
  t.after(() => room.stop());
  await room.start();
  await room.syncPeers("16:table", ["b"]);
  // Model a connection becoming healthy just before its queued watchdog runs.
  env.peers[0].connectionState = "connected";
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(env.peers[0].restarts, 0);
  assert.equal(env.peers.length, 1);
});

test("a new authoritative lobby identity revokes old negotiation and retains the muted capture stream", async () => {
  const env = browser(), sent = [], states = [];
  const room = new VoiceRoom("a", (...value) => sent.push(value), () => {}, (summary) => states.push(summary));
  await room.start();
  await room.syncPeers("old:table", ["b"]);
  room.setMicEnabled(true);
  const oldPeer = env.peers[0];
  const staleIce = oldPeer.onicecandidate;
  assert.equal(room.rebindIdentity("a"), false, "same active-game seat is a no-op");
  assert.equal(oldPeer.closed, false);
  assert.equal(room.rebindIdentity("z"), true);
  assert.equal(env.track.enabled, false);
  assert.equal(env.track.stopped, false, "rebind must not reprompt for or discard the authorized microphone");
  assert.equal(oldPeer.closed, true);
  const before = sent.length;
  staleIce({ candidate: { toJSON: () => ({ candidate: "stale" }) } });
  await room.handleSignal("b", { kind: "description", description: { type: "offer" } }, "old:table");
  await room.syncPeers("new:table", ["b"]);
  assert.equal(sent.length, before, "new z identity must wait for b, not initiate using old a ordering");
  assert.equal(env.peers.length, 1);
  await room.handleSignal("b", { kind: "description", description: { type: "offer" } }, "new:table");
  assert.equal(sent.at(-1)[1].description.type, "answer");
  assert.equal(sent.at(-1)[2], "new:table");
  room.configureScope("new:table", []);
  assert.equal(states.at(-1).state, "waiting");
  room.stop();
});

test("rebinding while an old offer is awaiting completion never emits that old offer", async () => {
  const env = browser(), sent = [];
  let release;
  env.deferOffer(new Promise((resolve) => { release = resolve; }));
  const room = new VoiceRoom("a", (...value) => sent.push(value), () => {});
  await room.start();
  const pending = room.syncPeers("old:table", ["b"]);
  room.rebindIdentity("z");
  release();
  await pending;
  assert.deepEqual(sent, []);
  assert.equal(env.peers[0].closed, true);
  assert.equal(env.track.stopped, false);
  room.stop();
});
