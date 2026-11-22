export type VoiceSignal =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

export type VoiceConfiguration = { t: "voice_config"; ice_servers: RTCIceServer[]; expires_at: number; relay_configured: boolean };
export type VoiceConnection = {
  state: "idle" | "waiting" | "connecting" | "connected" | "recovering" | "failed";
  connectedPeers: number;
  expectedPeers: number;
  receivingPeers: number;
  playbackBlocked: boolean;
  relayConfigured: boolean;
};

type SendSignal = (target: string, data: VoiceSignal, scope: string) => void;
type PeerSession = {
  peer: RTCPeerConnection;
  scope: string;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  candidates: RTCIceCandidateInit[];
  retries: number;
  exhausted: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  lastBytes: number;
  receiving: boolean;
};
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];
const MAX_RETRIES = 3;
const CONNECT_GRACE_MS = 12_000;
const DISCONNECT_GRACE_MS = 3_000;

/** Small, scope-authorized P2P room. TURN may be supplied by the server, never assumed. */
export class VoiceRoom {
  private stream: MediaStream | null = null;
  private peers = new Map<string, PeerSession>();
  private audio = new Map<string, HTMLAudioElement>();
  private blockedAudio = new Set<string>();
  private scope: string | null = null;
  private allowedPeers = new Set<string>();
  private stopped = false;
  private iceServers = DEFAULT_ICE;
  private relayConfigured = false;
  private configTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastSummary = "";

  constructor(
    private myId: string,
    private readonly sendSignal: SendSignal,
    private readonly onError: (message: string) => void,
    private readonly onConnection: (summary: VoiceConnection) => void = () => {},
    private readonly requestConfiguration: () => void = () => {},
  ) {}

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("이 브라우저는 실시간 음성 채팅을 지원하지 않습니다.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    this.setMicEnabled(false);
    this.requestConfiguration();
    this.statsTimer = setInterval(() => { void this.sampleIncoming(); }, 3_000);
    this.emitConnection();
  }

  /** A lobby reconnect may authoritatively assign a new seat, unlike an active
   * game resume. Revoke the old identity before negotiating under the new one. */
  rebindIdentity(id: string): boolean {
    if (this.stopped || !id || id.length > 128 || id === this.myId) return false;
    this.configureScope(null, []);
    this.myId = id;
    return true;
  }

  configureIce(configuration: VoiceConfiguration) {
    if (this.stopped || !Array.isArray(configuration.ice_servers)) return;
    const servers = configuration.ice_servers.slice(0, 8).filter((server) => {
      const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
      return Array.isArray(urls) && urls.length > 0 && urls.length <= 8 && urls.every((url) => typeof url === "string" && /^(stun|stuns|turn|turns):/.test(url));
    });
    if (!servers.length) return;
    const changed = JSON.stringify(this.iceServers) !== JSON.stringify(servers);
    this.iceServers = servers;
    this.relayConfigured = configuration.relay_configured === true;
    if (this.configTimer) clearTimeout(this.configTimer);
    this.configTimer = null;
    if (configuration.expires_at > 0) {
      const delay = Math.max(5_000, configuration.expires_at - Date.now() - 60_000);
      this.configTimer = setTimeout(() => { this.configTimer = null; if (!this.stopped) this.requestConfiguration(); }, Math.min(delay, 2_000_000_000));
    }
    if (changed) for (const [id, session] of this.peers) {
      try {
        session.peer.setConfiguration({ iceServers: this.iceServers });
        if (this.relayConfigured && session.peer.connectionState === "connected") {
          session.peer.restartIce();
          void this.negotiate(id, session, true);
        }
      }
      catch { this.scheduleRecovery(id, session); }
    }
    this.emitConnection();
  }

  /** Revoke the microphone/old peers synchronously before accepting another signal. */
  configureScope(scope: string | null, ids: string[]) {
    const changed = this.scope !== scope;
    this.scope = scope;
    this.allowedPeers = new Set(scope ? ids.filter((id) => id !== this.myId).slice(0, 12) : []);
    if (changed) {
      this.setMicEnabled(false);
      for (const id of [...this.peers.keys()]) this.closePeer(id);
    }
    for (const id of this.peers.keys()) if (!this.allowedPeers.has(id)) this.closePeer(id);
    this.emitConnection();
  }

  async syncPeers(scope: string | null, ids: string[]) {
    this.configureScope(scope, ids);
    if (!scope || !this.stream || this.stopped) return;
    for (const id of [...this.allowedPeers]) {
      if (this.stopped || this.scope !== scope || !this.allowedPeers.has(id)) return;
      if (this.peers.has(id) || this.myId.localeCompare(id) >= 0) continue;
      const session = this.createPeer(id, scope);
      await this.negotiate(id, session);
    }
    this.emitConnection();
  }

  async handleSignal(from: string, data: VoiceSignal, scope: string) {
    if (this.stopped || !scope || scope !== this.scope || !this.allowedPeers.has(from) || !this.stream) return;
    if (!data || (data.kind !== "description" && data.kind !== "candidate")) return;
    const session = this.peers.get(from) ?? this.createPeer(from, scope);
    const peer = session.peer;
    try {
      if (data.kind === "candidate") {
        if (session.ignoreOffer) return;
        if (!peer.remoteDescription) {
          if (session.candidates.length < 64) session.candidates.push(data.candidate);
        } else await peer.addIceCandidate(data.candidate);
        return;
      }
      const description = data.description;
      if (!description || !["offer", "answer"].includes(description.type)) return;
      const readyForOffer = !session.makingOffer && (peer.signalingState === "stable" || session.settingAnswer);
      const collision = description.type === "offer" && !readyForOffer;
      const polite = this.myId.localeCompare(from) > 0;
      session.ignoreOffer = !polite && collision;
      if (session.ignoreOffer) { session.candidates = []; return; }
      session.settingAnswer = description.type === "answer";
      // Modern WebRTC performs rollback when a polite peer accepts a colliding offer.
      await peer.setRemoteDescription(description);
      session.settingAnswer = false;
      if (!this.isCurrent(from, session)) return;
      for (const candidate of session.candidates) {
        if (!this.isCurrent(from, session)) return;
        await peer.addIceCandidate(candidate);
      }
      session.candidates = [];
      if (description.type === "offer") {
        const answer = await peer.createAnswer();
        if (!this.isCurrent(from, session)) return;
        await peer.setLocalDescription(answer);
        if (!this.isCurrent(from, session)) return;
        this.sendSignal(from, { kind: "description", description: peer.localDescription ?? answer }, scope);
      }
    } catch {
      session.settingAnswer = false;
      if (this.isCurrent(from, session)) this.scheduleRecovery(from, session);
    }
  }

  setMicEnabled(enabled: boolean) {
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = enabled && this.scope !== null && !this.stopped; });
  }

  /** Explicit retry resets the bounded recovery budget; it never changes scope permissions. */
  async retry() {
    if (this.stopped || !this.scope) return;
    const scope = this.scope;
    const ids = [...this.allowedPeers];
    this.requestConfiguration();
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    for (const id of ids) {
      if (this.stopped || this.scope !== scope || !this.allowedPeers.has(id)) return;
      const session = this.createPeer(id, scope);
      await this.negotiate(id, session, true);
    }
    await this.resumePlayback();
  }

  /** Must be called by a real user gesture when the browser blocks autoplay. */
  async resumePlayback() {
    for (const [id, element] of this.audio) {
      try { await element.play(); if (this.audio.get(id) === element) this.blockedAudio.delete(id); }
      catch { if (this.audio.get(id) === element) this.blockedAudio.add(id); }
    }
    this.emitConnection();
  }

  stop() {
    this.stopped = true;
    this.scope = null;
    this.allowedPeers.clear();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.configTimer) clearTimeout(this.configTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.configTimer = this.statsTimer = null;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.emitConnection();
  }

  private isCurrent(id: string, session: PeerSession) {
    return !this.stopped && this.scope === session.scope && this.allowedPeers.has(id) && this.peers.get(id) === session;
  }

  private async negotiate(id: string, session: PeerSession, restart = false) {
    const peer = session.peer;
    if (!this.isCurrent(id, session) || session.makingOffer || peer.signalingState !== "stable") return;
    try {
      session.makingOffer = true;
      const offer = await peer.createOffer(restart ? { iceRestart: true } : undefined);
      if (!this.isCurrent(id, session)) return;
      await peer.setLocalDescription(offer);
      if (!this.isCurrent(id, session)) return;
      this.sendSignal(id, { kind: "description", description: peer.localDescription ?? offer }, session.scope);
    } catch { if (this.isCurrent(id, session)) this.scheduleRecovery(id, session); }
    finally { session.makingOffer = false; }
  }

  private createPeer(id: string, scope: string): PeerSession {
    const peer = new RTCPeerConnection({ iceServers: this.iceServers });
    const session: PeerSession = { peer, scope, makingOffer: false, ignoreOffer: false, settingAnswer: false, candidates: [], retries: 0, exhausted: false, retryTimer: null, graceTimer: null, lastBytes: 0, receiving: false };
    this.peers.set(id, session);
    this.stream?.getTracks().forEach((track) => peer.addTrack(track, this.stream!));
    peer.onnegotiationneeded = () => { if (this.isCurrent(id, session)) void this.negotiate(id, session); };
    peer.onicecandidate = (event) => {
      if (event.candidate && this.isCurrent(id, session)) this.sendSignal(id, { kind: "candidate", candidate: event.candidate.toJSON() }, scope);
    };
    peer.ontrack = (event) => {
      if (!this.isCurrent(id, session)) return;
      const element = this.audio.get(id) ?? document.createElement("audio");
      element.autoplay = true;
      element.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      this.audio.set(id, element);
      void element.play().then(() => {
        if (this.isCurrent(id, session)) { this.blockedAudio.delete(id); this.emitConnection(); }
      }).catch(() => {
        if (!this.isCurrent(id, session)) return;
        this.blockedAudio.add(id);
        this.emitConnection();
        this.onError("음성 재생이 차단됐습니다. 음성 재생 버튼을 눌러 주세요.");
      });
    };
    peer.onconnectionstatechange = () => {
      if (!this.isCurrent(id, session)) return;
      if (peer.connectionState === "connected") {
        if (session.graceTimer) clearTimeout(session.graceTimer);
        if (session.retryTimer) clearTimeout(session.retryTimer);
        session.graceTimer = session.retryTimer = null;
        session.retries = 0;
        session.exhausted = false;
      } else if (["disconnected", "failed", "closed"].includes(peer.connectionState)) {
        session.receiving = false;
        if (!session.graceTimer && !session.retryTimer) {
          session.graceTimer = setTimeout(() => { session.graceTimer = null; this.scheduleRecovery(id, session); }, peer.connectionState === "disconnected" ? DISCONNECT_GRACE_MS : 0);
        }
      }
      this.emitConnection();
    };
    session.graceTimer = setTimeout(() => { session.graceTimer = null; this.scheduleRecovery(id, session); }, CONNECT_GRACE_MS);
    return session;
  }

  private scheduleRecovery(id: string, session: PeerSession) {
    if (!this.isCurrent(id, session) || session.retryTimer || session.exhausted) return;
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = null;
    // ICE restart can preserve an already-connected media path. A delayed
    // watchdog must not turn a recovered connection into an endless retry.
    if (session.peer.connectionState === "connected") {
      session.retries = 0;
      this.emitConnection();
      return;
    }
    if (session.retries >= MAX_RETRIES) {
      session.exhausted = true;
      this.emitConnection();
      this.onError("일부 음성 연결을 복구하지 못했습니다. 다시 연결하거나 다른 네트워크를 사용해 주세요.");
      return;
    }
    const delay = 1_000 * 2 ** session.retries;
    session.retries += 1;
    session.retryTimer = setTimeout(async () => {
      session.retryTimer = null;
      if (!this.isCurrent(id, session)) return;
      this.requestConfiguration();
      if (session.peer.signalingState !== "stable" || session.peer.connectionState === "closed") {
        const retries = session.retries;
        this.closePeer(id);
        const replacement = this.createPeer(id, session.scope);
        replacement.retries = retries;
        await this.negotiate(id, replacement, true);
        return;
      }
      session.peer.restartIce();
      await this.negotiate(id, session, true);
      if (!this.isCurrent(id, session)) return;
      session.graceTimer = setTimeout(() => { session.graceTimer = null; this.scheduleRecovery(id, session); }, CONNECT_GRACE_MS);
    }, delay);
    this.emitConnection();
  }

  private async sampleIncoming() {
    for (const [id, session] of this.peers) {
      if (session.peer.connectionState !== "connected" || typeof session.peer.getStats !== "function") continue;
      try {
        const stats = await session.peer.getStats();
        if (!this.isCurrent(id, session)) continue;
        let bytes = 0;
        stats.forEach((entry) => { if (entry.type === "inbound-rtp" && (entry.kind === "audio" || entry.mediaType === "audio")) bytes += entry.bytesReceived ?? 0; });
        session.receiving = bytes > session.lastBytes;
        session.lastBytes = bytes;
      } catch { /* Diagnostic sampling must not interrupt the media path. */ }
    }
    this.emitConnection();
  }

  private emitConnection() {
    const sessions = [...this.peers.values()];
    const connectedPeers = sessions.filter((session) => session.peer.connectionState === "connected").length;
    const summary: VoiceConnection = {
      state: !this.scope || !this.stream || this.stopped ? "idle" : this.allowedPeers.size === 0 ? "waiting" : sessions.some((session) => session.exhausted) ? "failed" : sessions.some((session) => session.retries > 0 || session.retryTimer) ? "recovering" : connectedPeers === this.allowedPeers.size ? "connected" : "connecting",
      connectedPeers, expectedPeers: this.allowedPeers.size,
      receivingPeers: sessions.filter((session) => session.receiving).length,
      playbackBlocked: this.blockedAudio.size > 0, relayConfigured: this.relayConfigured,
    };
    const serialized = JSON.stringify(summary);
    if (serialized !== this.lastSummary) { this.lastSummary = serialized; this.onConnection(summary); }
  }

  private closePeer(id: string) {
    const session = this.peers.get(id);
    this.peers.delete(id);
    if (session) {
      if (session.retryTimer) clearTimeout(session.retryTimer);
      if (session.graceTimer) clearTimeout(session.graceTimer);
      const peer = session.peer;
      peer.onicecandidate = peer.ontrack = peer.onconnectionstatechange = peer.onnegotiationneeded = null;
      peer.getReceivers().forEach((receiver) => receiver.track?.stop());
      peer.close();
    }
    this.blockedAudio.delete(id);
    const element = this.audio.get(id);
    if (element) { element.pause(); element.srcObject = null; }
    this.audio.delete(id);
  }
}
