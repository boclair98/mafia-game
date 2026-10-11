export type VoiceSignal =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

type SendSignal = (target: string, data: VoiceSignal, scope: string) => void;

/** Small peer-to-peer voice room using the existing game socket for signaling. */
export class VoiceRoom {
  private stream: MediaStream | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private audio = new Map<string, HTMLAudioElement>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private scope: string | null = null;
  private allowedPeers = new Set<string>();
  private stopped = false;

  constructor(
    private readonly myId: string,
    private readonly sendSignal: SendSignal,
    private readonly onError: (message: string) => void,
  ) {}

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("이 브라우저는 실시간 음성 채팅을 지원하지 않습니다.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.stopped) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    this.setMicEnabled(false);
  }

  /** Apply the server's permissions before accepting any following signal. */
  configureScope(scope: string | null, ids: string[]) {
    const changed = this.scope !== scope;
    this.scope = scope;
    this.allowedPeers = new Set(scope ? ids.filter((id) => id !== this.myId) : []);
    if (changed) {
      this.setMicEnabled(false);
      for (const id of [...this.peers.keys()]) this.closePeer(id);
      this.pendingCandidates.clear();
    }
    for (const id of this.peers.keys()) {
      if (!this.allowedPeers.has(id)) this.closePeer(id);
    }
  }

  async syncPeers(scope: string | null, ids: string[]) {
    this.configureScope(scope, ids);
    if (!scope || !this.stream || this.stopped) return;
    for (const id of this.allowedPeers) {
      if (this.peers.has(id) || this.myId.localeCompare(id) >= 0) continue;
      const peer = this.createPeer(id, scope);
      try {
        const offer = await peer.createOffer();
        if (!this.isCurrentPeer(id, peer, scope)) continue;
        await peer.setLocalDescription(offer);
        if (!this.isCurrentPeer(id, peer, scope)) continue;
        this.sendSignal(id, { kind: "description", description: offer }, scope);
      } catch {
        if (!this.isCurrentPeer(id, peer, scope)) continue;
        this.onError("음성 상대와 연결을 시작하지 못했습니다.");
        this.closePeer(id);
      }
    }
  }

  async handleSignal(from: string, data: VoiceSignal, scope: string) {
    if (this.stopped || !scope || scope !== this.scope || !this.allowedPeers.has(from) || !this.stream) return;
    if (!data || (data.kind !== "description" && data.kind !== "candidate")) return;
    const peer = this.peers.get(from) ?? this.createPeer(from, scope);
    try {
      if (data.kind === "candidate") {
        if (!peer.remoteDescription) {
          const queued = this.pendingCandidates.get(from) ?? [];
          if (queued.length >= 64) return;
          queued.push(data.candidate);
          this.pendingCandidates.set(from, queued);
        } else {
          await peer.addIceCandidate(data.candidate);
        }
        return;
      }
      await peer.setRemoteDescription(data.description);
      if (!this.isCurrentPeer(from, peer, scope)) return;
      const queued = this.pendingCandidates.get(from) ?? [];
      for (const candidate of queued) {
        if (!this.isCurrentPeer(from, peer, scope)) return;
        await peer.addIceCandidate(candidate);
      }
      this.pendingCandidates.delete(from);
      if (data.description.type === "offer") {
        const answer = await peer.createAnswer();
        if (!this.isCurrentPeer(from, peer, scope)) return;
        await peer.setLocalDescription(answer);
        if (!this.isCurrentPeer(from, peer, scope)) return;
        this.sendSignal(from, { kind: "description", description: answer }, scope);
      }
    } catch {
      if (!this.isCurrentPeer(from, peer, scope)) return;
      this.onError("일부 참가자와 음성 연결이 지연되고 있습니다.");
    }
  }

  setMicEnabled(enabled: boolean) {
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = enabled && this.scope !== null && !this.stopped; });
  }

  stop() {
    this.stopped = true;
    this.scope = null;
    this.allowedPeers.clear();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.pendingCandidates.clear();
  }

  private isCurrentPeer(id: string, peer: RTCPeerConnection, scope: string) {
    return !this.stopped && this.scope === scope && this.allowedPeers.has(id) && this.peers.get(id) === peer;
  }

  private createPeer(id: string, scope: string) {
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
      ],
    });
    this.stream?.getTracks().forEach((track) => peer.addTrack(track, this.stream!));
    peer.onicecandidate = (event) => {
      if (event.candidate && this.isCurrentPeer(id, peer, scope)) this.sendSignal(id, { kind: "candidate", candidate: event.candidate.toJSON() }, scope);
    };
    peer.ontrack = (event) => {
      if (!this.isCurrentPeer(id, peer, scope)) return;
      const element = this.audio.get(id) ?? document.createElement("audio");
      element.autoplay = true;
      element.srcObject = event.streams[0];
      this.audio.set(id, element);
      void element.play().catch(() => {
        if (this.isCurrentPeer(id, peer, scope)) this.onError("화면을 한 번 눌러 음성 재생을 허용해 주세요.");
      });
    };
    peer.onconnectionstatechange = () => {
      if (this.isCurrentPeer(id, peer, scope) && (peer.connectionState === "failed" || peer.connectionState === "closed")) this.closePeer(id);
    };
    this.peers.set(id, peer);
    return peer;
  }

  private closePeer(id: string) {
    const peer = this.peers.get(id);
    this.peers.delete(id);
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.getReceivers().forEach((receiver) => receiver.track?.stop());
      peer.close();
    }
    this.pendingCandidates.delete(id);
    const element = this.audio.get(id);
    if (element) {
      element.pause();
      element.srcObject = null;
    }
    this.audio.delete(id);
  }
}
