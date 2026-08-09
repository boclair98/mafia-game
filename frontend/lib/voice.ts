export type VoiceSignal =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

type SendSignal = (target: string, data: VoiceSignal) => void;

/** Small peer-to-peer voice room using the existing game socket for signaling. */
export class VoiceRoom {
  private stream: MediaStream | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private audio = new Map<string, HTMLAudioElement>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  constructor(
    private readonly myId: string,
    private readonly sendSignal: SendSignal,
    private readonly onError: (message: string) => void,
  ) {}

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("이 브라우저는 실시간 음성 채팅을 지원하지 않습니다.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  async syncPeers(ids: string[]) {
    const wanted = new Set(ids.filter((id) => id !== this.myId));
    for (const id of this.peers.keys()) {
      if (!wanted.has(id)) this.closePeer(id);
    }
    for (const id of wanted) {
      if (this.peers.has(id) || this.myId.localeCompare(id) >= 0) continue;
      const peer = this.createPeer(id);
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        this.sendSignal(id, { kind: "description", description: offer });
      } catch {
        this.onError("음성 상대와 연결을 시작하지 못했습니다.");
        this.closePeer(id);
      }
    }
  }

  async handleSignal(from: string, data: VoiceSignal) {
    if (!data || (data.kind !== "description" && data.kind !== "candidate")) return;
    const peer = this.peers.get(from) ?? this.createPeer(from);
    try {
      if (data.kind === "candidate") {
        if (!peer.remoteDescription) {
          const queued = this.pendingCandidates.get(from) ?? [];
          queued.push(data.candidate);
          this.pendingCandidates.set(from, queued);
        } else {
          await peer.addIceCandidate(data.candidate);
        }
        return;
      }
      await peer.setRemoteDescription(data.description);
      const queued = this.pendingCandidates.get(from) ?? [];
      for (const candidate of queued) await peer.addIceCandidate(candidate);
      this.pendingCandidates.delete(from);
      if (data.description.type === "offer") {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.sendSignal(from, { kind: "description", description: answer });
      }
    } catch {
      this.onError("일부 참가자와 음성 연결이 지연되고 있습니다.");
    }
  }

  setMicEnabled(enabled: boolean) {
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }

  private createPeer(id: string) {
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
      ],
    });
    this.stream?.getTracks().forEach((track) => peer.addTrack(track, this.stream!));
    peer.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal(id, { kind: "candidate", candidate: event.candidate.toJSON() });
    };
    peer.ontrack = (event) => {
      const element = this.audio.get(id) ?? document.createElement("audio");
      element.autoplay = true;
      element.srcObject = event.streams[0];
      this.audio.set(id, element);
      void element.play().catch(() => this.onError("화면을 한 번 눌러 음성 재생을 허용해 주세요."));
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") this.closePeer(id);
    };
    this.peers.set(id, peer);
    return peer;
  }

  private closePeer(id: string) {
    this.peers.get(id)?.close();
    this.peers.delete(id);
    this.pendingCandidates.delete(id);
    const element = this.audio.get(id);
    if (element) {
      element.pause();
      element.srcObject = null;
    }
    this.audio.delete(id);
  }
}
