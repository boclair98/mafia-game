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
  class Peer {
    constructor() { this.remoteDescription = null; this.ice = []; this.closed = false; peers.push(this); }
    addTrack() {}
    async createOffer() { if (offerGate) await offerGate; return { type: "offer", sdp: "mock-offer" }; }
    async createAnswer() { return { type: "answer", sdp: "mock-answer" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async addIceCandidate(candidate) { this.ice.push(candidate); }
    getReceivers() { return []; }
    close() { this.closed = true; }
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  globalThis.RTCPeerConnection = Peer;
  globalThis.document = { createElement: () => {
    const element = { srcObject: null, paused: false, async play() {}, pause() { this.paused = true; } };
    audio.push(element);
    return element;
  } };
  return { peers, audio, track, deferOffer: (promise) => { offerGate = promise; } };
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
