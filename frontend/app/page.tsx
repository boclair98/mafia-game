"use client";

import {
  Activity, Ban, Bot, BookOpen, Check, ChevronLeft, ChevronRight, Clipboard, Crosshair, Download, Eye, FileText, Film, Flag, Gavel,
  Headphones, HeartPulse, LockKeyhole, LogIn, MessageCircle, Mic, MicOff, Moon, PhoneOff, Radio, RotateCcw, Search, Send, Siren,
  Settings, Share2, ShieldCheck, ShieldQuestion, Skull, Smartphone, Sparkles,
  TimerReset, Trophy, UserPlus, Users, Volume2, Vote, X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { GameState, PlayerState, Role, WelcomeMsg } from "@/lib/game";
import { fetchGameStatus, fetchLeaderboard, type GameStatus, type LeaderboardEntry } from "@/lib/api";
import { signInHref, useMe } from "@/lib/identity";
import { VoiceRoom, type VoiceSignal } from "@/lib/voice";
import { type ConnStatus, GameSocket, gameSocketUrl } from "@/lib/ws";

const ROLE_META: Record<Role, { name: string; icon: typeof Skull; copy: string; color: string; goal: string; power: string; cover: string }> = {
  mafia: { name: "마피아", icon: Skull, copy: "밤마다 시민 한 명을 제거하세요. 동료와 비밀 대화를 나눌 수 있습니다.", color: "crimson", goal: "마피아 수가 시민 수와 같아질 때까지 생존", power: "야간 습격 · 비밀 채팅", cover: "낮에는 시민 역할의 행동을 구체적으로 설명하세요." },
  doctor: { name: "의사", icon: HeartPulse, copy: "매일 밤 한 명을 치료해 마피아의 습격에서 구하세요.", color: "emerald", goal: "핵심 시민을 살려 마피아 전원 검거", power: "매일 밤 1명 치료", cover: "정체 공개는 마피아의 표적이 될 수 있습니다." },
  detective: { name: "탐정", icon: Eye, copy: "매일 밤 한 명을 조사해 마피아인지 확인하세요.", color: "violet", goal: "조사 기록으로 마피아 전원 검거", power: "매일 밤 1명 신원 조사", cover: "확실한 증거가 생길 때까지 조사 결과를 아끼세요." },
  bodyguard: { name: "경호원", icon: ShieldCheck, copy: "한 명을 경호하세요. 습격받으면 당신이 대신 희생됩니다.", color: "sky", goal: "핵심 시민을 지키며 마피아 전원 검거", power: "야간 대리 희생 경호", cover: "누가 중요 인물인지 말하지 말고 조용히 보호하세요." },
  trickster: { name: "광대", icon: Sparkles, copy: "어느 팀에도 속하지 않습니다. 시민 투표로 처형되면 즉시 단독 승리합니다.", color: "pink", goal: "시민 투표에서 자신이 처형되도록 유도", power: "처형 즉시 단독 승리", cover: "너무 노골적인 거짓말은 오히려 표를 잃습니다." },
  citizen: { name: "시민", icon: ShieldQuestion, copy: "토론과 투표로 숨어 있는 마피아를 모두 찾아내세요.", color: "amber", goal: "토론과 투표로 마피아 전원 검거", power: "질문 · 기록 · 시민 투표", cover: "이전 발언과 야간 행동의 모순을 찾아내세요." },
  spectator: { name: "관전자", icon: Eye, copy: "이미 진행 중인 게임입니다. 다음 판을 기다리며 지켜보세요.", color: "slate", goal: "사건의 흐름을 관찰하고 다음 판 준비", power: "전체 진행 관전", cover: "사건 기록에서 결정적인 전환점을 찾아보세요." },
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type LocalStats = { games: number; wins: number; streak: number };
type LegalPage = "terms" | "privacy" | "community";

const PHASE_META = {
  lobby: ["용의자 대기실", "모두가 정체를 숨기면 자정의 사건이 시작됩니다."],
  reveal: ["역할 확인", "당신의 정체는 오직 당신만 볼 수 있습니다."],
  night: ["밤", "고개를 숙이고 자신의 행동을 선택하세요."],
  dawn: ["새벽", "밤사이 도시에 무슨 일이 있었을까요?"],
  day: ["낮 · 자유 토론", "모두 대화하되 현재 집중 발언자의 주장을 놓치지 마세요."],
  vote: ["시민 투표", "가장 의심스러운 한 사람을 지목하세요."],
  defense: ["최후 변론", "지목된 용의자의 마지막 진술을 들으세요."],
  verdict: ["최종 판결", "변론을 들었다면 처형 또는 석방을 결정하세요."],
  result: ["투표 결과", "도시의 선택은 공개되지만 정체는 아직 비밀입니다."],
  gameover: ["게임 종료", "승패가 결정되었습니다."],
} as const;

const PHASE_ALERT_META: Record<GameState["phase"], { kicker: string; title: string; copy: string; icon: typeof Moon }> = {
  lobby: { kicker: "CASE LOBBY", title: "용의자 대기실", copy: "친구를 초대하고 모두 준비해 주세요.", icon: Users },
  reveal: { kicker: "IDENTITY REVEALED", title: "배역이 공개되었습니다", copy: "이 정체는 오직 당신만 볼 수 있습니다.", icon: ShieldQuestion },
  night: { kicker: "NIGHT HAS FALLEN", title: "밤이 되었습니다", copy: "말을 멈추고 자신의 능력을 선택하세요.", icon: Moon },
  dawn: { kicker: "DAWN REPORT", title: "새벽이 밝았습니다", copy: "밤사이 벌어진 사건이 곧 공개됩니다.", icon: Eye },
  day: { kicker: "OPEN DISCUSSION", title: "자유 토론이 시작됩니다", copy: "모두 발언할 수 있습니다. 집중 발언자의 주장과 반박을 비교하세요.", icon: MessageCircle },
  vote: { kicker: "FINAL BALLOT", title: "시민 투표가 시작됩니다", copy: "처형할 용의자 한 명을 선택하세요.", icon: Vote },
  defense: { kicker: "FINAL DEFENSE", title: "최후 변론이 시작됩니다", copy: "피고에게만 마지막 발언권이 주어집니다.", icon: MessageCircle },
  verdict: { kicker: "CITY VERDICT", title: "최종 판결을 내려주세요", copy: "처형 또는 석방. 이제 도시가 결정합니다.", icon: Gavel },
  result: { kicker: "VERDICT", title: "판결을 집행합니다", copy: "처형 결과만 공개됩니다. 정체는 사건 종료까지 비밀입니다.", icon: Skull },
  gameover: { kicker: "CASE CLOSED", title: "사건이 종료되었습니다", copy: "승리 팀과 모든 배역을 확인하세요.", icon: Sparkles },
};

const PHASE_NARRATION: Record<GameState["phase"], string> = {
  lobby: "용의자 대기실입니다.",
  reveal: "배역이 공개되었습니다. 자신의 정체를 확인하세요.",
  night: "밤이 되었습니다. 모두 눈을 감으세요.",
  dawn: "새벽 사건 보고입니다.",
  day: "자유 토론을 시작합니다. 모든 생존자에게 발언권이 열립니다.",
  vote: "시민 투표를 시작합니다.",
  defense: "최후 변론을 시작합니다.",
  verdict: "처형 또는 석방을 결정하세요.",
  result: "도시의 판결을 공개합니다.",
  gameover: "사건이 종료되었습니다.",
};

function phaseNarration(game: GameState, phase: GameState["phase"]) {
  const latest = game.story.at(-1);
  const accused = game.players.find((player) => player.id === game.accused_id);
  if ((phase === "dawn" || phase === "result" || phase === "gameover") && latest) return latest;
  if (phase === "defense" && accused) return `${accused.n}님의 최후 변론을 시작합니다.`;
  return PHASE_NARRATION[phase];
}

const PHASE_TRACK: GameState["phase"][] = ["reveal", "night", "dawn", "day", "vote", "defense", "verdict", "result"];
const PHASE_THREAT: Record<GameState["phase"], number> = { lobby: 8, reveal: 24, night: 72, dawn: 58, day: 42, vote: 82, defense: 88, verdict: 96, result: 94, gameover: 100 };
const REACTION_EMOJIS = ["👀", "⚠️", "👍", "🤥", "❓", "🩸"];
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };

const TUTORIAL_SCENES = [
  { tag: "SCENE 01 · 정체", title: "밤에는 역할이 움직입니다", copy: "마피아는 습격하고, 의사와 경호원은 누군가를 지키며, 탐정은 단 한 명의 진실을 확인합니다.", icon: Moon },
  { tag: "SCENE 02 · 감식", title: "단서는 범인을 포함합니다", copy: "새벽마다 공개되는 현장 단서는 실제 습격자와 무고한 용의자를 함께 가리킵니다. 후보들의 알리바이를 직접 비교하세요.", icon: Search },
  { tag: "SCENE 03 · 토론", title: "낮에는 말이 증거입니다", copy: "모두 자유롭게 대화하면서 집중 발언자의 주장을 확인하세요. 질문과 신뢰·보류·의심 판단은 투표 전에 근거로 공개됩니다.", icon: MessageCircle },
  { tag: "SCENE 04 · 재판", title: "지목은 곧 처형이 아닙니다", copy: "가장 많은 표를 받은 피고에게 최후 변론이 주어집니다. 진술을 들은 생존자들이 처형 또는 석방을 최종 결정합니다.", icon: Gavel },
  { tag: "SCENE 05 · 복기", title: "모든 거짓말은 사건 파일에 남습니다", copy: "게임이 끝나면 현장 단서, 역할과 전체 진술을 되짚어 보세요. 다음 판에는 같은 거짓말이 통하지 않을 겁니다.", icon: BookOpen },
];

const LANDING_SCENES = [
  { tag: "SCENE LOCKED", title: "살인 현장이 봉쇄되었습니다", copy: "용의자는 전원 이 방 안에 있습니다. 첫 번째 밤 행동을 선택하세요.", icon: Moon, tone: "night" },
  { tag: "FORENSIC CLUE", title: "현장 단서가 도착했습니다", copy: "단서는 범인을 포함한 소수의 용의자를 가리키지만 결론까지 알려주지는 않습니다.", icon: Search, tone: "interrogation" },
  { tag: "INTERROGATION", title: "진술의 모순을 추적합니다", copy: "알리바이를 묻고, 공개 진술과 현장 기록을 대조하세요.", icon: Radio, tone: "vote" },
  { tag: "FINAL VERDICT", title: "범인을 지목할 시간입니다", copy: "최후 변론을 들은 뒤 처형 또는 석방을 결정합니다.", icon: Gavel, tone: "reveal" },
] as const;

const LANDING_ROLES = [
  { code: "ROLE 01", name: "마피아", tagline: "밤의 살인자", copy: "낮에는 가장 믿을 만한 시민처럼 말해야 합니다.", avatar: 2 },
  { code: "ROLE 02", name: "탐정", tagline: "진실의 추적자", copy: "확실한 조사 결과도 공개 시점을 잘못 고르면 표적이 됩니다.", avatar: 5 },
  { code: "ROLE 03", name: "광대", tagline: "처형을 원하는 자", copy: "수상해 보여야 하지만 마피아에게 먼저 죽어서는 안 됩니다.", avatar: 10 },
  { code: "ROLE 04", name: "시민", tagline: "말을 쫓는 증인", copy: "능력 대신 질문과 기록으로 거짓말의 모순을 찾습니다.", avatar: 8 },
] as const;

function makeRoom() {
  const left = ["silent", "black", "hidden", "last", "red"];
  const right = ["moon", "alley", "hotel", "signal", "midnight"];
  return `${left[Math.floor(Math.random() * left.length)]}-${right[Math.floor(Math.random() * right.length)]}-${Math.floor(100 + Math.random() * 900)}`;
}

function getPlayerKey(room: string) {
  const storageKey = `black-midnight:${room}`;
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID().replaceAll("-", "");
    sessionStorage.setItem(storageKey, key);
  }
  return key;
}

function secondsLeft(deadline: number, now: number) {
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}

export default function GamePage() {
  const identity = useMe();
  const socketRef = useRef<GameSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [joined, setJoined] = useState(false);
  const [nick, setNick] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [room, setRoom] = useState("");
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [welcome, setWelcome] = useState<WelcomeMsg | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [chatText, setChatText] = useState("");
  const [questionText, setQuestionText] = useState("");
  const [claimText, setClaimText] = useState("");
  const [willText, setWillText] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);
  const [copied, setCopied] = useState(false);
  const [invitedByLink, setInvitedByLink] = useState(false);
  const [landingScene, setLandingScene] = useState(0);
  const [landingRole, setLandingRole] = useState(0);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [stats, setStats] = useState<LocalStats>({ games: 0, wins: 0, streak: 0 });
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [caseOpen, setCaseOpen] = useState(false);
  const [rankingOpen, setRankingOpen] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [networkStatus, setNetworkStatus] = useState<GameStatus | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceChatOn, setVoiceChatOn] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [legalPage, setLegalPage] = useState<LegalPage | null>(null);
  const [reportTarget, setReportTarget] = useState<{ id: string; name: string } | null>(null);
  const [reportReason, setReportReason] = useState("괴롭힘 또는 혐오 발언");
  const [blockedPlayers, setBlockedPlayers] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Record<string, -1 | 0 | 1>>({});
  const [mobileTab, setMobileTab] = useState<"case" | "suspects" | "talk" | "role">("suspects");
  const [phaseAlert, setPhaseAlert] = useState<GameState["phase"] | null>(null);
  const [decisionFlash, setDecisionFlash] = useState<{ label: string; target: string } | null>(null);
  const previousPhase = useRef<string | null>(null);
  const phaseAlertTimer = useRef<number | null>(null);
  const decisionFlashTimer = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const voiceRoomRef = useRef<VoiceRoom | null>(null);
  const lastCountdownBeep = useRef<number | null>(null);
  const soundPhase = game?.phase;
  const countdownRemaining = game ? secondsLeft(game.deadline, now) : 0;
  const narrationText = game && soundPhase ? phaseNarration(game, soundPhase) : "";
  const voiceCanSpeak = Boolean(game?.me.alive && (
    ["lobby", "day", "vote", "gameover"].includes(game.phase)
    || (game.phase === "defense" && game.me.id === game.accused_id)
  ));
  const voicePeerKey = game?.players.filter((player) => player.voice && !player.bot && player.id !== game.me.id && !blockedPlayers.includes(player.id)).map((player) => player.id).sort().join("|") ?? "";
  const myVoicePresent = game?.players.find((player) => player.id === game.me.id)?.voice ?? false;

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      setRoomInput(params.get("room") || makeRoom());
      setInvitedByLink(Boolean(params.get("room")));
      setNick(localStorage.getItem("black-midnight:nick") || "");
      const savedStats = localStorage.getItem("black-midnight:stats");
      if (savedStats) {
        try { setStats(JSON.parse(savedStats) as LocalStats); } catch { localStorage.removeItem("black-midnight:stats"); }
      }
      if (!localStorage.getItem("black-midnight:tutorial-seen")) setTutorialOpen(true);
      setVoiceOn(localStorage.getItem("black-midnight:voice") === "1");
      setSoundOn(localStorage.getItem("black-midnight:sound") === "1");
      setTermsAccepted(localStorage.getItem("black-midnight:terms-v1") === "1");
      try { setBlockedPlayers(JSON.parse(localStorage.getItem("black-midnight:blocked") || "[]") as string[]); } catch { localStorage.removeItem("black-midnight:blocked"); }
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => {
      mounted = false;
      window.removeEventListener("beforeinstallprompt", onInstall);
    };
  }, []);

  useEffect(() => {
    if (joined) return;
    const timer = window.setInterval(() => {
      setLandingScene((current) => (current + 1) % LANDING_SCENES.length);
      setLandingRole((current) => (current + 1) % LANDING_ROLES.length);
    }, 4200);
    return () => window.clearInterval(timer);
  }, [joined]);

  useEffect(() => {
    let active = true;
    fetchLeaderboard().then((entries) => { if (active) setLeaderboard(entries); }).catch(() => undefined);
    const refreshStatus = () => fetchGameStatus().then((next) => { if (active) setNetworkStatus(next); }).catch(() => undefined);
    void refreshStatus();
    const timer = window.setInterval(refreshStatus, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (game?.phase !== "gameover") return;
    const timer = window.setTimeout(() => {
      fetchLeaderboard().then(setLeaderboard).catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [game?.phase]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const modalOpen = tutorialOpen || inviteOpen || caseOpen || rankingOpen || settingsOpen || Boolean(legalPage) || Boolean(reportTarget);
    if (!modalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeTopModal = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (caseOpen) setCaseOpen(false);
      else if (reportTarget) setReportTarget(null);
      else if (legalPage) setLegalPage(null);
      else if (settingsOpen) setSettingsOpen(false);
      else if (rankingOpen) setRankingOpen(false);
      else if (inviteOpen) setInviteOpen(false);
      else if (tutorialOpen) {
        localStorage.setItem("black-midnight:tutorial-seen", "1");
        setTutorialOpen(false);
      }
    };
    window.addEventListener("keydown", closeTopModal);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeTopModal);
    };
  }, [caseOpen, inviteOpen, legalPage, rankingOpen, reportTarget, settingsOpen, tutorialOpen]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [game?.chat.length]);

  useEffect(() => {
    if (!game) return;
    const changed = previousPhase.current ? previousPhase.current !== game.phase : game.phase !== "lobby";
    if (changed) {
      lastCountdownBeep.current = null;
      setPhaseAlert(game.phase);
      setMobileTab(game.phase === "reveal" ? "role" : ["dawn", "result", "gameover"].includes(game.phase) ? "case" : "suspects");
      if (phaseAlertTimer.current) window.clearTimeout(phaseAlertTimer.current);
      phaseAlertTimer.current = window.setTimeout(() => setPhaseAlert(null), 3400);
    }
    if (previousPhase.current && previousPhase.current !== game.phase && "vibrate" in navigator) {
      navigator.vibrate(game.phase === "vote" || game.phase === "night" ? [70, 35, 70] : 45);
    }
    if (game.phase === "gameover" && previousPhase.current !== "gameover") {
      const won = (game.winner === "mafia" && game.me.role === "mafia")
        || (game.winner === "citizen" && !["mafia", "trickster", "spectator"].includes(game.me.role))
        || (game.winner === "trickster" && game.me.role === "trickster");
      setStats((current) => {
        const next = { games: current.games + 1, wins: current.wins + (won ? 1 : 0), streak: won ? current.streak + 1 : 0 };
        localStorage.setItem("black-midnight:stats", JSON.stringify(next));
        return next;
      });
    }
    previousPhase.current = game.phase;
  }, [game]);

  useEffect(() => () => {
    if (phaseAlertTimer.current) window.clearTimeout(phaseAlertTimer.current);
    if (decisionFlashTimer.current) window.clearTimeout(decisionFlashTimer.current);
    if (audioContextRef.current) void audioContextRef.current.close();
    voiceRoomRef.current?.stop();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  useEffect(() => {
    if (!soundOn || !soundPhase || soundPhase === "lobby") return;
    const AudioContextClass = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = audioContextRef.current ?? new AudioContextClass();
    audioContextRef.current = context;
    void context.resume().catch(() => undefined);
    const start = context.currentTime + 0.02;
    const cueMap: Record<GameState["phase"], number[]> = {
      lobby: [180], reveal: [220, 330], night: [130, 98], dawn: [260, 390],
      day: [330, 440], vote: [170, 170, 220], defense: [150, 210], verdict: [110, 165, 110], result: [120, 90], gameover: [196, 294, 392],
    };
    const nodes: OscillatorNode[] = [];
    cueMap[soundPhase].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = soundPhase === "night" || soundPhase === "result" ? "sawtooth" : "sine";
      oscillator.frequency.setValueAtTime(frequency, start + index * 0.16);
      gain.gain.setValueAtTime(0.0001, start + index * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.035, start + index * 0.16 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.16 + 0.55);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + index * 0.16);
      oscillator.stop(start + index * 0.16 + 0.58);
      nodes.push(oscillator);
    });
    return () => nodes.forEach((node) => { try { node.stop(); } catch { /* cue already ended */ } });
  }, [soundPhase, soundOn]);

  useEffect(() => {
    if (!soundOn || countdownRemaining <= 0 || countdownRemaining > 5 || countdownRemaining === lastCountdownBeep.current) return;
    const AudioContextClass = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = audioContextRef.current ?? new AudioContextClass();
    audioContextRef.current = context;
    lastCountdownBeep.current = countdownRemaining;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = countdownRemaining === 1 ? "square" : "sine";
    oscillator.frequency.value = 470 + (5 - countdownRemaining) * 85;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + .015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + .13);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + .14);
  }, [countdownRemaining, soundOn]);

  useEffect(() => {
    if (!tutorialOpen) return;
    const timer = window.setInterval(() => setTutorialStep((step) => Math.min(step + 1, TUTORIAL_SCENES.length - 1)), 6500);
    return () => window.clearInterval(timer);
  }, [tutorialOpen]);

  useEffect(() => {
    if (!voiceOn || !soundPhase || !narrationText || !("speechSynthesis" in window)) return;
    const line = new SpeechSynthesisUtterance(narrationText);
    const voices = window.speechSynthesis.getVoices();
    const koreanVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith("ko"));
    line.voice = koreanVoices.find((voice) => /(injoon|hyunsu|male|남성|natural|neural)/i.test(voice.name))
      ?? koreanVoices.find((voice) => /(google|microsoft|apple)/i.test(voice.name))
      ?? koreanVoices[0]
      ?? null;
    line.lang = "ko-KR";
    line.rate = 0.9;
    line.pitch = 0.72;
    line.volume = 0.92;
    window.speechSynthesis.speak(line);
  }, [narrationText, soundPhase, voiceOn]);

  useEffect(() => {
    if (!joined || !room || !nick) return;
    const key = getPlayerKey(room);
    const socket = new GameSocket(gameSocketUrl(room, nick, key), {
      onStatus: setStatus,
      onMessage: (raw) => {
        const msg = raw as WelcomeMsg | GameState | { t: "error" | "notice"; message: string } | { t: "voice_signal"; from: string; data: VoiceSignal };
        if (msg.t === "welcome") {
          setWelcome(msg as WelcomeMsg);
        } else if (msg.t === "state") {
          const next = msg as GameState;
          setGame({
            ...next,
            players: next.players.map((player) => ({ ...player, score: player.score ?? 0, voice: player.voice ?? false })),
            accused_id: next.accused_id ?? null,
            judgement_counts: next.judgement_counts ?? { execute: 0, spare: 0 },
            ballot_feed: next.ballot_feed ?? [],
            clues: next.clues ?? [],
            decision_progress: next.decision_progress ?? { completed: 0, total: 0 },
            case_log: next.case_log ?? next.story ?? [],
            reactions: next.reactions ?? [],
            speaker_id: next.speaker_id ?? null,
            speaker_deadline: next.speaker_deadline ?? 0,
            interrogation_order: next.interrogation_order ?? [],
            questions: next.questions ?? [],
            claims: next.claims ?? [],
            read_summary: next.read_summary ?? {},
            moments: next.moments ?? [],
            me: {
              ...next.me,
              reads: next.me.reads ?? {},
              can_leave_will: next.me.can_leave_will ?? false,
            },
          });
          setSelected((current) => current && next.players.some((p) => p.id === current && p.alive) ? current : null);
        } else if (msg.t === "error" || msg.t === "notice") {
          setNotice(msg.message);
          window.setTimeout(() => setNotice(""), 3200);
        } else if (msg.t === "voice_signal") {
          void voiceRoomRef.current?.handleSignal(msg.from, msg.data);
        }
      },
    });
    socketRef.current = socket;
    return () => socket.close();
  }, [joined, room, nick]);

  useEffect(() => {
    if (!voiceChatOn) return;
    void voiceRoomRef.current?.syncPeers(voicePeerKey ? voicePeerKey.split("|") : []);
    if (!myVoicePresent) socketRef.current?.send({ t: "voice_presence", enabled: true });
  }, [myVoicePresent, voiceChatOn, voicePeerKey]);

  useEffect(() => {
    if (!voiceChatOn) return;
    voiceRoomRef.current?.setMicEnabled(voiceCanSpeak && !micMuted);
  }, [micMuted, voiceCanSpeak, voiceChatOn]);

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    const safeNick = nick.trim().slice(0, 16);
    const safeRoom = roomInput.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || makeRoom();
    if (!safeNick || !termsAccepted) return;
    localStorage.setItem("black-midnight:terms-v1", "1");
    localStorage.setItem("black-midnight:nick", safeNick);
    history.replaceState(null, "", `?room=${encodeURIComponent(safeRoom)}`);
    setNick(safeNick);
    setRoom(safeRoom);
    setJoined(true);
  };

  const send = (message: object) => socketRef.current?.send(message);
  const blockPlayer = (id: string, name: string) => {
    const next = blockedPlayers.includes(id) ? blockedPlayers.filter((item) => item !== id) : [...blockedPlayers, id];
    setBlockedPlayers(next);
    localStorage.setItem("black-midnight:blocked", JSON.stringify(next));
    setNotice(next.includes(id) ? `${name}님을 차단했습니다. 대화와 음성이 숨겨집니다.` : `${name}님의 차단을 해제했습니다.`);
    window.setTimeout(() => setNotice(""), 3200);
  };
  const submitReport = (event: FormEvent) => {
    event.preventDefault();
    if (!reportTarget) return;
    send({ t: "report", target: reportTarget.id, reason: reportReason });
    setReportTarget(null);
  };
  const me = game?.players.find((player) => player.id === game.me.id);
  const role = game?.me.role || "citizen";
  const roleMeta = ROLE_META[role];
  const RoleIcon = roleMeta.icon;
  const phase = game ? PHASE_META[game.phase] : PHASE_META.lobby;
  const remaining = countdownRemaining;
  const alertMeta = phaseAlert ? PHASE_ALERT_META[phaseAlert] : null;
  const PhaseAlertIcon = alertMeta?.icon ?? Moon;
  const phaseProgressIndex = game?.phase === "gameover" ? PHASE_TRACK.length : game ? PHASE_TRACK.indexOf(game.phase) : -1;
  const selectedPlayer = game?.players.find((player) => player.id === selected) ?? null;
  const selectedPlayerIndex = selectedPlayer && game ? game.players.findIndex((player) => player.id === selectedPlayer.id) : 0;
  const urgencyBoost = remaining > 0 && remaining <= 10 ? (10 - remaining) * 2 : 0;
  const cityThreat = game ? Math.min(100, PHASE_THREAT[game.phase] + urgencyBoost) : 0;
  const aliveCount = game?.players.filter((player) => player.alive).length ?? 0;
  const lostCount = game ? game.players.length - aliveCount : 0;
  const accusedPlayer = game?.players.find((player) => player.id === game.accused_id) ?? null;
  const accusedIndex = accusedPlayer && game ? game.players.findIndex((player) => player.id === accusedPlayer.id) : 0;
  const isAccused = Boolean(game && game.me.id === game.accused_id);
  const unreadyPlayers = game?.players.filter((player) => !player.bot && player.id !== game.host && !player.ready) ?? [];
  const readyHumans = game?.players.filter((player) => !player.bot && (player.id === game.host || player.ready)).length ?? 0;
  const humanCount = game?.players.filter((player) => !player.bot).length ?? 0;
  const currentSpeaker = game?.players.find((player) => player.id === game.speaker_id) ?? null;
  const currentSpeakerIndex = currentSpeaker && game ? game.players.findIndex((player) => player.id === currentSpeaker.id) : 0;
  const isCurrentSpeaker = Boolean(game && game.me.id === game.speaker_id);
  const speakerRemaining = game ? secondsLeft(game.speaker_deadline, now) : 0;
  const canChat = Boolean(game && ["lobby", "vote", "gameover"].includes(game.phase)
    || game?.phase === "day" && game.me.alive
    || game?.phase === "defense" && isAccused && game.me.alive
    || game?.phase === "night" && role === "mafia" && game.me.alive);
  const canReact = Boolean(game && ["day", "vote", "defense", "verdict", "gameover"].includes(game.phase));
  const voiceCount = game?.players.filter((player) => player.voice).length ?? 0;

  const targetPlayers = useMemo(() => {
    if (!game) return [];
    return game.players.filter((player) => {
      if (!player.alive) return false;
      if (game.phase === "vote") return player.id !== game.me.id;
      if (game.phase !== "night") return false;
      if (role === "mafia") return !player.mafia;
      if (role === "detective") return player.id !== game.me.id;
      return role === "doctor" || role === "bodyguard";
    });
  }, [game, role]);

  const actionCopy = role === "mafia" ? "습격할 시민" : role === "doctor" ? "치료할 사람" : "조사할 사람";
  const refinedActionCopy = role === "bodyguard" ? "경호할 사람" : actionCopy;
  const currentDirective = !game || game.phase === "lobby" ? "용의자를 모으고 모두 준비 상태인지 확인하세요."
    : game.phase === "reveal" ? roleMeta.goal
    : game.phase === "night" ? (["mafia", "doctor", "detective", "bodyguard"].includes(role) ? roleMeta.power : "침묵을 유지하고 아침의 사건 보고를 기다리세요.")
    : game.phase === "day" ? "모두 자유롭게 토론합니다. 집중 발언자의 모순은 질문함과 추리 보드에 따로 기록하세요."
    : game.phase === "vote" ? "개인 기록과 공개 발언을 대조한 뒤 최종 표를 봉인하세요."
    : game.phase === "defense" ? (isAccused ? "당신의 마지막 변론입니다. 행동과 주장을 명확히 설명하세요." : "피고의 마지막 진술에서 모순을 찾으세요.")
    : game.phase === "verdict" ? (isAccused ? "도시의 최종 결정을 기다리세요." : "감정이 아닌 발언과 사건 기록을 근거로 판결하세요.")
    : game.phase === "gameover" ? "최종 사건 파일을 복기하고 다음 판의 전략을 세우세요."
    : "사건 보고를 확인하고 다음 단계에 대비하세요.";

  const installApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const closeTutorial = () => {
    localStorage.setItem("black-midnight:tutorial-seen", "1");
    setTutorialOpen(false);
  };

  const copyInvite = async () => {
    await navigator.clipboard.writeText(`${location.origin}/?room=${room}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const shareInvite = async () => {
    const url = `${location.origin}/?room=${room}`;
    const text = `검은 자정 방 '${room}'에 초대합니다. 역할은 비밀, 거짓말은 자유. 지금 입장하세요!`;
    if (navigator.share) {
      await navigator.share({ title: "검은 자정 초대", text, url }).catch(() => undefined);
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    setNotice("초대 메시지를 복사했습니다.");
  };

  const createPoster = async (kind: "invite" | "result") => {
    const image = new Image();
    image.src = "/midnight-city-ui.webp";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1350;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
    ctx.drawImage(image, (canvas.width - image.width * scale) / 2, (canvas.height - image.height * scale) / 2, image.width * scale, image.height * scale);
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "rgba(5,7,10,.15)");
    gradient.addColorStop(.42, "rgba(5,7,10,.58)");
    gradient.addColorStop(1, "rgba(5,7,10,.97)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#d22b3f";
    ctx.fillRect(80, 86, 84, 8);
    ctx.fillStyle = "#eeeae2";
    ctx.font = "700 72px serif";
    ctx.fillText("검은 자정", 80, 185);
    ctx.fillStyle = "#a1a5ad";
    ctx.font = "500 25px sans-serif";
    ctx.fillText("BLACK MIDNIGHT · SOCIAL DEDUCTION", 84, 232);
    if (kind === "invite") {
      ctx.fillStyle = "#d22b3f";
      ctx.font = "700 28px sans-serif";
      ctx.fillText("PRIVATE INVITATION", 84, 840);
      ctx.fillStyle = "#eeeae2";
      ctx.font = "700 56px sans-serif";
      ctx.fillText("당신을 자정의 테이블로 초대합니다", 84, 920);
      ctx.fillStyle = "#a1a5ad";
      ctx.font = "400 30px sans-serif";
      ctx.fillText("설치 없이 링크를 열고, 이름만 정하면 시작됩니다.", 84, 978);
      ctx.fillStyle = "#eeeae2";
      ctx.font = "700 86px monospace";
      ctx.fillText(room, 84, 1102);
      ctx.fillStyle = "#777d87";
      ctx.font = "500 23px sans-serif";
      ctx.fillText("ROOM CODE", 88, 1142);
    } else if (game) {
      const winner = game.winner === "mafia" ? "마피아 팀 승리" : game.winner === "trickster" ? "광대 단독 승리" : "시민 팀 승리";
      ctx.fillStyle = "#d22b3f";
      ctx.font = "700 28px sans-serif";
      ctx.fillText("CASE CLOSED", 84, 845);
      ctx.fillStyle = "#eeeae2";
      ctx.font = "700 72px sans-serif";
      ctx.fillText(winner, 84, 940);
      ctx.fillStyle = "#b9bdc4";
      ctx.font = "500 34px sans-serif";
      ctx.fillText(`나의 역할 · ${roleMeta.name}`, 84, 1010);
      ctx.fillText(`사건 기록 · ${game.round}일째 밤`, 84, 1062);
    }
    ctx.fillStyle = "#737984";
    ctx.font = "400 24px monospace";
    ctx.fillText("black-midnight.coders.kr", 84, 1240);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    const file = new File([blob], kind === "invite" ? "black-midnight-invite.png" : "black-midnight-case-file.png", { type: "image/png" });
    const shareData = { title: "검은 자정", text: kind === "invite" ? `방 코드 ${room}에서 기다리고 있습니다.` : "검은 자정 사건 기록", files: [file] };
    if (navigator.share && navigator.canShare?.(shareData)) {
      await navigator.share(shareData).catch(() => undefined);
      return;
    }
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = file.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const toggleVoice = () => {
    const next = !voiceOn;
    setVoiceOn(next);
    localStorage.setItem("black-midnight:voice", next ? "1" : "0");
    if (!next && "speechSynthesis" in window) window.speechSynthesis.cancel();
  };

  const toggleVoiceChat = async () => {
    if (voiceChatOn) {
      send({ t: "voice_presence", enabled: false });
      voiceRoomRef.current?.stop();
      voiceRoomRef.current = null;
      setVoiceChatOn(false);
      setMicMuted(false);
      return;
    }
    if (!welcome) return;
    const room = new VoiceRoom(
      welcome.id,
      (target, data) => send({ t: "voice_signal", target, data }),
      (message) => {
        setNotice(message);
        window.setTimeout(() => setNotice(""), 3600);
      },
    );
    try {
      await room.start();
      voiceRoomRef.current = room;
      setVoiceChatOn(true);
      setMicMuted(false);
      send({ t: "voice_presence", enabled: true });
    } catch (error) {
      room.stop();
      setNotice(error instanceof Error && error.message.includes("지원")
        ? error.message
        : "마이크 권한을 허용해야 음성 채팅에 참여할 수 있습니다.");
      window.setTimeout(() => setNotice(""), 4200);
    }
  };

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    localStorage.setItem("black-midnight:sound", next ? "1" : "0");
    if (!next) return;
    const AudioContextClass = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = audioContextRef.current ?? new AudioContextClass();
    audioContextRef.current = context;
    void context.resume().catch(() => undefined);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 330;
    gain.gain.setValueAtTime(0.025, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.2);
  };

  const commitDecision = (kind: "action" | "vote") => {
    if (!selectedPlayer) return;
    send({ t: kind, target: selectedPlayer.id });
    const label = kind === "vote" ? "투표 봉인 완료" : `${refinedActionCopy} 선택 완료`;
    setDecisionFlash({ label, target: selectedPlayer.n });
    if (decisionFlashTimer.current) window.clearTimeout(decisionFlashTimer.current);
    decisionFlashTimer.current = window.setTimeout(() => setDecisionFlash(null), 2600);
    if ("vibrate" in navigator) navigator.vibrate(kind === "vote" ? [45, 30, 90] : 60);
  };

  const commitJudgement = (execute: boolean) => {
    send({ t: "judge", execute });
    setDecisionFlash({ label: execute ? "처형 판결 봉인" : "석방 판결 봉인", target: accusedPlayer?.n ?? "피고" });
    if (decisionFlashTimer.current) window.clearTimeout(decisionFlashTimer.current);
    decisionFlashTimer.current = window.setTimeout(() => setDecisionFlash(null), 2600);
    if ("vibrate" in navigator) navigator.vibrate(execute ? [45, 30, 90] : 55);
  };

  const submitChat = (event: FormEvent) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    send({ t: "chat", text });
    setChatText("");
  };

  const submitQuestion = (event: FormEvent) => {
    event.preventDefault();
    const text = questionText.trim();
    if (!text || !currentSpeaker) return;
    send({ t: "question", text });
    setQuestionText("");
  };

  const submitClaim = (event: FormEvent) => {
    event.preventDefault();
    const text = claimText.trim();
    if (!text) return;
    send({ t: "claim", text });
    setClaimText("");
  };

  const submitWill = (event: FormEvent) => {
    event.preventDefault();
    const text = willText.trim();
    if (!text) return;
    send({ t: "will", text });
    setWillText("");
  };

  const copyCaseFile = async () => {
    if (!game) return;
    const roles = game.players.filter((player) => player.role).map((player) => `${player.n} — ${ROLE_META[player.role!].name} · ${player.score}점`).join("\n");
    const clues = game.clues.map((clue) => `${clue.code} ${clue.title} — ${clue.detail}`).join("\n");
    const history = game.case_log.map((line, index) => `${String(index + 1).padStart(2, "0")}  ${line}`).join("\n");
    await navigator.clipboard.writeText(`[검은 자정 · ${room}]\n${roles}\n\n현장 단서\n${clues || "아직 확보된 단서 없음"}\n\n사건 기록\n${history}`);
    setNotice("전체 사건 기록을 복사했습니다.");
  };

  const focusJoinCard = () => {
    document.querySelector<HTMLElement>(".join-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => document.querySelector<HTMLInputElement>("#landing-nick")?.focus(), 480);
  };

  const landingSceneMeta = LANDING_SCENES[landingScene];
  const LandingSceneIcon = landingSceneMeta.icon;
  const landingRoleMeta = LANDING_ROLES[landingRole];

  if (!joined) {
    return (
      <main className="landing-shell">
        <div className="grain" />
        <div className="landing-atmosphere" aria-hidden="true"><i /><i /><i /><span /></div>
        <header className="landing-nav"><div><Search size={17} /><b>검은 자정 · 사건 파일</b></div><button className="landing-settings" onClick={() => setSettingsOpen(true)} aria-label="설정과 운영 정책"><Settings size={16} /></button><span><i />INVESTIGATION NETWORK{networkStatus ? ` · ${networkStatus.players}명 접속 · ${networkStatus.active_matches}건 수사 중` : ""}</span></header>
        <div className="city-coordinate"><span>37°34&apos;N · 126°58&apos;E</span><b>MIDNIGHT DISTRICT / LIVE FEED 00:42</b></div>
        <section className="landing-copy">
          <div className="eyebrow"><span /> INTERACTIVE MURDER MYSTERY</div>
          <h1><span>검은</span> <em>자정</em></h1>
          <p className="hero-line">한 명이 죽었다. 범인은 아직 이 방 안에 있다.</p>
          <div className="mafia-warning"><Search size={18} /><span><b>CASE 042 · 밀실 살인</b><small>현장 단서를 대조하고, 거짓 알리바이를 깨고, 범인을 찾아내라.</small></span><i>UNSOLVED</i></div>
          <div key={landingSceneMeta.tag} className={`landing-live-case tone-${landingSceneMeta.tone}`} aria-live="polite">
            <div className="live-case-visual"><LandingSceneIcon size={23} /><span><i />LIVE CASE</span></div>
            <div className="live-case-copy"><small>{landingSceneMeta.tag}</small><b>{landingSceneMeta.title}</b><p>{landingSceneMeta.copy}</p></div>
            <div className="live-case-steps">{LANDING_SCENES.map((scene, index) => <button key={scene.tag} className={index === landingScene ? "active" : ""} onClick={() => setLandingScene(index)} aria-label={`${scene.title} 미리보기`}><i /></button>)}</div>
          </div>
          <div className="role-selector">
            <div className="role-strip">{LANDING_ROLES.map((item, index) => <button type="button" key={item.code} className={`landing-role ${index === landingRole ? "active" : ""}`} onClick={() => setLandingRole(index)}><div className={`role-face avatar-photo avatar-${item.avatar}`} /><span><small>{item.code}</small><b>{item.name}</b><em>{item.tagline}</em></span></button>)}</div>
            <div className="role-whisper"><span>{landingRoleMeta.name} 생존 전략</span><p>{landingRoleMeta.copy}</p></div>
          </div>
          <button className="hero-join-cta" type="button" onClick={focusJoinCard}><span><b>{invitedByLink ? "초대받은 수사에 합류" : "새 사건 수사 시작"}</b><small>모바일·PC 어디서나 설치 없이 바로 입장</small></span><ChevronRight size={18} /></button>
          <div className="local-stats"><div><b>{stats.games}</b><span>플레이</span></div><div><b>{stats.wins}</b><span>승리</span></div><div><b>{stats.streak}</b><span>연승</span></div></div>
          <button className="ranking-launch" type="button" onClick={() => setRankingOpen(true)}><Trophy size={16} /><span><b>명예의 전당</b><small>{leaderboard[0] ? `현재 1위 ${leaderboard[0].name} · ${leaderboard[0].best_score}점` : "첫 번째 전설이 되어보세요"}</small></span><ChevronRight size={16} /></button>
          <button className="briefing-launch" type="button" onClick={() => { setTutorialStep(0); setTutorialOpen(true); }}><Film size={16} /><span><b>30초 AI 시네마틱 브리핑</b><small>룰을 몰라도 한 번에 이해하기</small></span><ChevronRight size={16} /></button>
        </section>
        <section className="join-card">
          <div className="join-scanline" />
          <div className="join-card-top">
            <span>PRIVATE TABLE</span>
            <span className="live-dot">온라인</span>
          </div>
          {invitedByLink && <div className="invited-room"><UserPlus size={15} /><span><b>비밀 초대장이 도착했습니다</b><small>{roomInput} 사건의 자리가 확보되어 있습니다.</small></span></div>}
          <div className="join-presence"><div><span className="avatar-photo avatar-1" /><span className="avatar-photo avatar-4" /><span className="avatar-photo avatar-7" /></div><p>{networkStatus ? <><b>{networkStatus.players}명</b>이 현재 도시 네트워크에 접속 중</> : <>실시간 도시 네트워크 연결 중</>}</p></div>
          <h2>{invitedByLink ? "수사 초대에 응답" : "사건 담당자 등록"}</h2>
          <p>수사에서 사용할 이름을 정하세요. 입장 후 누군가는 범인, 누군가는 진실을 쫓는 역할을 받습니다.</p>
          <div className="join-steps"><span className="active"><b>01</b>이름 설정</span><i /><span><b>02</b>친구 합류</span><i /><span><b>03</b>역할 봉인</span></div>
          <div className="join-warning"><Skull size={14} /><span>입장 후 배역은 봉인됩니다. 아무도 믿지 마세요.</span></div>
          <form onSubmit={submitJoin}>
            <label><span>당신의 이름 <em>{nick.length}/16</em></span><input id="landing-nick" value={nick} onChange={(e) => setNick(e.target.value)} placeholder="게임에서 불릴 이름" maxLength={16} /></label>
            <label><span>비밀 방 코드 <em>{invitedByLink ? "초대 링크에서 확인됨" : "친구와 공유할 코드"}</em></span><div className="room-field"><input value={roomInput} onChange={(e) => { setRoomInput(e.target.value); setInvitedByLink(false); }} maxLength={32} /><button type="button" onClick={() => { setRoomInput(makeRoom()); setInvitedByLink(false); }} aria-label="새 방 코드 만들기"><RotateCcw size={15} /></button></div></label>
            <label className="terms-check"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} /><span><b>커뮤니티 규칙과 이용약관에 동의합니다</b><small><button type="button" onClick={() => setLegalPage("terms")}>이용약관</button> · <button type="button" onClick={() => setLegalPage("community")}>커뮤니티 가이드</button> · <button type="button" onClick={() => setLegalPage("privacy")}>개인정보</button></small></span></label>
            <button className="primary-button join-enter-button" type="submit" disabled={!nick.trim() || !termsAccepted}><LogIn size={18} /><span>{!termsAccepted ? "규칙에 동의하고 입장" : nick.trim() ? `${nick.trim()}으로 수사 합류` : "이름을 입력하고 수사 합류"}</span><ChevronRight size={16} /></button>
          </form>
          {installPrompt && <button className="install-button" type="button" onClick={installApp}><Smartphone size={16} /> 홈 화면에 앱 설치</button>}
          <div className="join-proof"><span><Check size={12} />설치 없음</span><span><Check size={12} />AI 인원 채우기</span><span><Check size={12} />실시간 음성</span></div>
          <div className="join-foot"><Users size={15} /> 최소 4명부터 시작 · 최대 12명 · 초보자 브리핑 제공</div>
        </section>
        {tutorialOpen && <TutorialModal step={tutorialStep} setStep={setTutorialStep} onClose={closeTutorial} />}
        {rankingOpen && <RankingModal entries={leaderboard} signedIn={Boolean(identity)} onClose={() => setRankingOpen(false)} />}
        {settingsOpen && <SettingsModal voiceOn={voiceOn} soundOn={soundOn} onVoice={toggleVoice} onSound={toggleSound} onLegal={setLegalPage} onClose={() => setSettingsOpen(false)} />}
        {legalPage && <LegalModal page={legalPage} onClose={() => setLegalPage(null)} />}
      </main>
    );
  }

  if (!game || !welcome) {
    return <main className="loading-screen"><Moon className="moon-loader" /><p>도시의 불을 끄는 중…</p></main>;
  }

  return (
    <main className={`game-shell phase-${game.phase} mobile-view-${mobileTab} ${remaining > 0 && remaining <= 10 && game.phase !== "reveal" ? "is-urgent" : ""}`}>
      <div className="grain" />
      <div className="city-atmosphere" aria-hidden="true"><i /><i /><i /></div>
      {notice && <div className="toast">{notice}</div>}
      {decisionFlash && <div className="decision-flash" role="status"><LockKeyhole size={18} /><span><small>COMMAND SEALED</small><b>{decisionFlash.label}</b><em>{decisionFlash.target}</em></span></div>}
      {phaseAlert && alertMeta && (
        <div className={`phase-alert phase-alert-${phaseAlert}`} role="status" aria-live="assertive">
          <div className="phase-alert-card">
            <span className="phase-alert-kicker">{alertMeta.kicker}</span>
            <div className="phase-alert-icon"><PhaseAlertIcon size={30} /></div>
            <h2>{alertMeta.title}</h2>
            <p>{alertMeta.copy}</p>
            {voiceOn && <div className="phase-alert-voice"><Volume2 size={13} /><span>{phaseNarration(game, phaseAlert)}</span></div>}
            {remaining > 0 && <div className="phase-alert-countdown"><b>{remaining}</b><span>초 남음</span></div>}
            <div className="phase-alert-line"><i /></div>
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="mini-brand"><Moon size={18} fill="currentColor" /><span>검은 자정</span><button className="guide-button" onClick={() => { setTutorialStep(0); setTutorialOpen(true); }}><Film size={13} />룰 안내</button><button className="guide-button" onClick={() => setRankingOpen(true)}><Trophy size={13} />랭킹</button><button className="guide-button" onClick={() => setSettingsOpen(true)}><Settings size={13} />설정</button></div>
        <div className="room-pill"><span>ROOM</span><b>{room}</b><button onClick={copyInvite} aria-label="초대 링크 복사">{copied ? <Check size={15} /> : <Clipboard size={15} />}</button><button onClick={() => setInviteOpen(true)} aria-label="친구 초대 열기"><UserPlus size={15} /></button></div>
        <div className={`connection ${status}`}><i />{status === "open" ? `${game.players.filter((p) => p.connected).length}명 접속` : "재연결 중"}</div>
      </header>

      <section className="phase-banner">
        <div className="threat-monitor"><div><Siren size={14} /><span>CITY THREAT</span><b>{cityThreat}%</b></div><div className="threat-bar"><i style={{ width: `${cityThreat}%` }} /></div><small>{aliveCount} ALIVE · {lostCount} LOST</small></div>
        <div className="phase-kicker">{game.case_profile.code} · {game.case_profile.location} · {game.round ? `DAY ${game.round}` : "WAITING ROOM"}</div>
        <h1>{phase[0]}</h1>
        <p>{phase[1]}</p>
        <div className="phase-now" aria-live="polite"><i /><b>{PHASE_ALERT_META[game.phase].title}</b><span>{remaining > 0 ? `${remaining}초 남음` : game.phase === "lobby" ? "시작 대기 중" : "진행 중"}</span></div>
        <div className="active-directive"><Crosshair size={13} /><span><small>ACTIVE DIRECTIVE</small><b>{currentDirective}</b></span></div>
        <div className="phase-track" aria-label="게임 진행 단계">
          {PHASE_TRACK.map((stage, index) => <div key={stage} className={`${game.phase === stage ? "active" : ""} ${phaseProgressIndex > index ? "done" : ""}`}><i /><span>{PHASE_META[stage][0]}</span></div>)}
        </div>
        {game.deadline > 0 && <div className={`timer ${remaining <= 10 ? "urgent" : ""}`}><span>{String(Math.floor(remaining / 60)).padStart(2, "0")}</span>:<span>{String(remaining % 60).padStart(2, "0")}</span></div>}
      </section>

      <div className="game-grid">
        <aside className={`role-panel role-${roleMeta.color}`}>
          {game.phase === "lobby" ? <><div className="panel-label">SEALED IDENTITY</div><div className="sealed-role"><ShieldQuestion size={36} /><span>CLASSIFIED</span></div><h2>배역 봉인</h2><p>게임이 시작되는 순간 당신만의 역할이 공개됩니다.</p><div className="sealed-notice"><Skull size={14} /><span>이 방의 누군가는 마피아가 됩니다.</span></div></> : <><div className="panel-label">MY SECRET</div><div className={`role-photo avatar-photo avatar-${Math.max(0, game.players.findIndex((player) => player.id === game.me.id)) % 12}`}><span><RoleIcon size={24} /></span></div><h2>{roleMeta.name}</h2><p>{roleMeta.copy}</p><div className="role-dossier"><div><Crosshair size={13} /><span><small>WIN CONDITION</small><b>{roleMeta.goal}</b></span></div><div><Activity size={13} /><span><small>FIELD ABILITY</small><b>{roleMeta.power}</b></span></div><p>{roleMeta.cover}</p></div>{role === "mafia" && <div className="secret-box"><b>마피아 동료</b><span>{game.players.filter((p) => p.mafia && p.id !== game.me.id).map((p) => p.n).join(", ") || "당신 혼자입니다"}</span></div>}{game.me.intel.length > 0 && <div className="secret-box intel"><b>조사 기록</b>{game.me.intel.map((line) => <span key={line}>{line}</span>)}</div>}{game.me.mission && <div className="secret-box mission"><b>이번 판 비밀 미션</b><span>{game.me.mission}</span></div>}<div className="evidence-board"><div><Search size={14} /><b>나만의 추리 보드</b></div>{game.players.filter((player) => player.id !== game.me.id).slice(0, 8).map((player) => <div className="evidence-row" key={player.id}><span>{player.n}</span><button className={evidence[player.id] === 1 ? "safe active" : "safe"} onClick={() => setEvidence((current) => ({ ...current, [player.id]: current[player.id] === 1 ? 0 : 1 }))}>안전</button><button className={evidence[player.id] === -1 ? "suspect active" : "suspect"} onClick={() => setEvidence((current) => ({ ...current, [player.id]: current[player.id] === -1 ? 0 : -1 }))}>의심</button></div>)}</div>{!game.me.alive && role !== "spectator" && <div className="dead-stamp">사망</div>}</>}
        </aside>

        <section className="table-panel">
          <div className="panel-heading"><div><span>{game.phase === "lobby" ? "SUSPECT FILES" : "THE TABLE"}</span><h2>{game.phase === "lobby" ? "용의자 명단" : "참가자"}</h2></div><div>{game.players.filter((p) => p.alive).length} 생존</div></div>
          {accusedPlayer && ["defense", "verdict"].includes(game.phase) && (
            <div className={`trial-stage trial-${game.phase}`}>
              <div className="trial-light" />
              <div className={`trial-portrait avatar-photo avatar-${Math.max(0, accusedIndex) % 12}`}><span>ACCUSED</span></div>
              <div className="trial-copy">
                <small>{game.phase === "defense" ? "FINAL DEFENSE IN PROGRESS" : "CITY VERDICT IN PROGRESS"}</small>
                <h2>{accusedPlayer.n}</h2>
                <p>{game.phase === "defense" ? (isAccused ? "마지막 발언권이 당신에게 주어졌습니다." : "피고의 진술이 끝날 때까지 판결을 보류하세요.") : "처형은 과반이 아니라 석방 표보다 많아야 집행됩니다."}</p>
                {game.phase === "verdict" && <div className="verdict-meter"><span className="execute" style={{ flex: Math.max(1, game.judgement_counts.execute) }}>처형 {game.judgement_counts.execute}</span><span className="spare" style={{ flex: Math.max(1, game.judgement_counts.spare) }}>석방 {game.judgement_counts.spare}</span></div>}
              </div>
              <Gavel size={30} />
            </div>
          )}
          {game.phase === "day" && currentSpeaker && (
            <section className="interrogation-stage" aria-label="자유 토론 집중 발언">
              <div className={`interrogation-photo avatar-photo avatar-${Math.max(0, currentSpeakerIndex) % 12}`}><span>ON AIR</span></div>
              <div className="interrogation-main">
                <div className="interrogation-heading"><span>OPEN DISCUSSION · ROUND {game.round}</span><b>{currentSpeaker.n}님 집중 발언</b><em>{speakerRemaining}초</em></div>
                <div className="speaker-order">{game.interrogation_order.map((id, index) => { const player = game.players.find((item) => item.id === id); return <span key={id} className={id === game.speaker_id ? "active" : ""}>{index + 1}. {player?.n ?? "?"}</span>; })}</div>
                <div className="question-feed">{game.questions.length === 0 ? <p>아직 도착한 질문이 없습니다. 발언의 모순을 구체적으로 질문하세요.</p> : game.questions.map((question) => <p key={question.id}><b>{question.from}</b><span>{question.text}</span></p>)}</div>
                {isCurrentSpeaker ? (
                  <form className="claim-form" onSubmit={submitClaim}><input value={claimText} onChange={(event) => setClaimText(event.target.value)} maxLength={120} placeholder="이번 라운드의 핵심 주장을 한 문장으로 봉인하세요" /><button disabled={!claimText.trim() || game.claims.some((claim) => claim.round === game.round && claim.speaker_id === game.me.id)}><LockKeyhole size={14} />공식 진술 봉인</button></form>
                ) : game.me.alive ? (
                  <div className="interrogation-response">
                    <form onSubmit={submitQuestion}><input value={questionText} onChange={(event) => setQuestionText(event.target.value)} maxLength={100} placeholder={`${currentSpeaker.n}님에게 질문하기`} /><button disabled={!questionText.trim()}><Send size={14} /></button></form>
                    <div><span>나의 현재 판단</span>{(["trust", "hold", "suspect"] as const).map((stance) => <button key={stance} className={game.me.reads[currentSpeaker.id] === stance ? `active ${stance}` : stance} onClick={() => send({ t: "read", target: currentSpeaker.id, stance })}>{stance === "trust" ? "신뢰" : stance === "hold" ? "보류" : "의심"}</button>)}</div>
                  </div>
                ) : <div className="interrogation-observer">사망자는 질문과 판단에 참여할 수 없지만 모든 진술을 열람할 수 있습니다.</div>}
              </div>
            </section>
          )}
          {game.phase === "vote" && Object.keys(game.read_summary).length > 0 && (
            <section className="read-summary-panel"><header><Search size={16} /><span><b>심문 사전 판단 공개</b><small>투표 전까지 비공개였던 신뢰·의심 기록입니다. 다수의 판단이 진실을 보장하지는 않습니다.</small></span></header><div>{game.players.filter((player) => player.alive).map((player) => { const summary = game.read_summary[player.id] ?? { trust: 0, hold: 0, suspect: 0 }; return <article key={player.id}><b>{player.n}</b><span className="trust">신뢰 {summary.trust}</span><span>보류 {summary.hold}</span><span className="suspect">의심 {summary.suspect}</span></article>; })}</div></section>
          )}
          {["vote", "defense", "verdict", "result"].includes(game.phase) && (
            <section className="ballot-call" aria-live="polite">
              <header><Vote size={16} /><span><b>공개 투표 호명</b><small>{game.phase === "vote" ? `봉인 완료 ${game.decision_progress.completed}/${game.decision_progress.total}` : "최후 변론에 오른 표의 흐름"}</small></span></header>
              <div>{game.ballot_feed.length ? game.ballot_feed.map((entry, index) => <article key={entry.voter_id}><em>{String(index + 1).padStart(2, "0")}</em><b>{entry.voter}</b><ChevronRight size={12} /><span>{entry.target}</span></article>) : <p>첫 번째 표가 봉인되기를 기다리고 있습니다.</p>}</div>
            </section>
          )}
          {game.phase === "gameover" && game.moments.length > 0 && (
            <section className="replay-panel"><header><Film size={17} /><span><b>결정적 장면 리플레이</b><small>주장과 판결이 어떻게 승부를 바꿨는지 시간순으로 복기합니다.</small></span></header><div>{game.moments.slice(-8).map((moment, index) => <article key={moment.id}><span>{String(index + 1).padStart(2, "0")}</span><div><small>{moment.kind.toUpperCase()} · DAY {moment.round}</small><p>{moment.text}</p></div></article>)}</div></section>
          )}
          <div className="reaction-layer" aria-live="polite">{game.reactions.map((reaction, index) => <div key={reaction.id} style={{ left: `${12 + (index * 17) % 74}%`, animationDelay: `${(index % 3) * .08}s` }}><b>{reaction.emoji}</b><span>{reaction.from}</span></div>)}</div>
          <div className="player-grid">
            {game.players.map((player, index) => (
              <PlayerCard key={player.id} player={player} index={index} self={player.id === game.me.id} host={player.id === game.host} accused={player.id === game.accused_id} selected={selected === player.id} selectable={targetPlayers.some((p) => p.id === player.id)} mark={evidence[player.id] ?? 0} phase={game.phase} onSelect={() => setSelected(player.id)} />
            ))}
            {game.phase === "lobby" && Array.from({ length: Math.max(0, game.min_players - game.players.length) }).map((_, i) => <div className="empty-seat" key={i}><span>+</span><p>빈자리</p></div>)}
          </div>
          {game.phase === "lobby" && game.host === game.me.id && game.players.some((player) => player.id !== game.me.id) && <div className="host-roster-tools"><span>HOST CONTROL</span>{game.players.filter((player) => player.id !== game.me.id).map((player) => <button key={player.id} onClick={() => send({ t: "remove_seat", target: player.id })} aria-label={`${player.n} 대기실에서 내보내기`}><X size={11} />{player.n}</button>)}</div>}

          {selectedPlayer && ["night", "vote"].includes(game.phase) && <div className={`target-lock ${game.phase === "vote" ? "vote-lock" : ""}`}><div className={`target-lock-photo avatar-photo avatar-${Math.max(0, selectedPlayerIndex) % 12}`} /><Crosshair size={18} /><span><small>{game.phase === "vote" ? "EXECUTION CANDIDATE" : "TARGET LOCKED"}</small><b>{selectedPlayer.n}</b><em>{game.phase === "vote" ? "최종 투표 대상" : refinedActionCopy}</em></span><button onClick={() => setSelected(null)} aria-label="선택 대상 해제"><X size={15} /></button></div>}
          <div className="action-bar">
            {game.phase === "lobby" && (
              <>
                <div><b>{game.players.length}/{game.max_players}명 등록 · 사람 준비 {readyHumans}/{humanCount} · {game.pace === "quick" ? "퀵 약 12분" : "클래식 20분+"}</b><span>{unreadyPlayers.length ? `${unreadyPlayers.map((player) => player.n).slice(0, 3).join(", ")}님의 준비를 기다리는 중입니다.` : "역할 배정 준비가 끝났습니다."}</span></div>
                {game.host === game.me.id && <div className="pace-switch"><button className={game.pace === "quick" ? "active" : ""} onClick={() => send({ t: "pace", pace: "quick" })}><TimerReset size={14} />퀵 · 약 12분</button><button className={game.pace === "classic" ? "active" : ""} onClick={() => send({ t: "pace", pace: "classic" })}>클래식 · 20분+</button></div>}
                {game.host === game.me.id && <div className="bot-fill-switch"><Bot size={14} /><span>AI 인원</span>{[4, 6, 8].map((target) => <button key={target} className={game.players.length === target ? "active" : ""} onClick={() => send({ t: "fill_bots", target })}>{target}</button>)}</div>}
                <button className="secondary-button" onClick={() => setInviteOpen(true)}><UserPlus size={17} />친구 초대</button>
                {game.host !== game.me.id && <button className="secondary-button" onClick={() => send({ t: "ready" })}>{me?.ready ? <Check size={17} /> : <ShieldQuestion size={17} />}{me?.ready ? "준비 취소" : "준비하기"}</button>}
                {game.host === game.me.id && <button className="primary-button compact start-game-button" disabled={game.players.length < game.min_players || unreadyPlayers.length > 0} onClick={() => send({ t: "start" })}><Skull size={17} /><span>{unreadyPlayers.length ? `${unreadyPlayers.length}명 준비 대기` : "게임 시작"}</span></button>}
              </>
            )}
            {game.phase === "night" && game.me.alive && ["mafia", "doctor", "detective", "bodyguard"].includes(role) && (
              <><div><b>{refinedActionCopy}을 선택하세요</b><span>시간 안에는 선택을 바꿀 수 있습니다.</span></div><button className="primary-button compact seal-button" disabled={!selected} onClick={() => commitDecision("action")}><LockKeyhole size={17} />{game.me.action_target ? "명령 변경" : "명령 봉인"}</button></>
            )}
            {game.phase === "night" && (!game.me.alive || role === "citizen") && <div><b>도시가 잠들었습니다</b><span>{game.me.alive ? "아침이 올 때까지 눈을 감고 기다리세요." : "남은 플레이어들의 밤을 지켜보고 있습니다."}</span></div>}
            {game.phase === "vote" && game.me.alive && <><div><b>처형할 사람을 선택하세요</b><span>투표 완료 {game.decision_progress.completed}/{game.decision_progress.total} · 모두 투표하면 자동 마감됩니다.</span></div><button className="danger-button seal-button" disabled={!selected} onClick={() => commitDecision("vote")}><LockKeyhole size={17} />{game.me.vote_target ? "투표 변경" : "투표 봉인"}</button></>}
            {game.phase === "day" && <div><b>{isCurrentSpeaker ? "당신이 현재 집중 발언자입니다" : `${currentSpeaker?.n ?? "다음 참가자"}님 집중 발언 중`}</b><span>{isCurrentSpeaker ? "모두 들을 수 있습니다. 핵심 주장을 봉인하세요." : "자유롭게 반박하면서 질문과 개인 판단도 따로 기록하세요."}</span></div>}
            {game.phase === "dawn" && game.me.can_leave_will && <form className="will-form" onSubmit={submitWill}><div><b>마지막 유언 1회</b><span>다음 토론에 남길 마지막 단서를 작성하세요.</span></div><input value={willText} onChange={(event) => setWillText(event.target.value)} maxLength={120} placeholder="마지막으로 시민에게 남길 말" /><button className="danger-button" disabled={!willText.trim()}><Skull size={16} />유언 공개</button></form>}
            {game.phase === "defense" && <div><b>{isAccused ? "당신의 최후 변론" : `${accusedPlayer?.n ?? "피고"}의 최후 변론`}</b><span>{isAccused ? "채팅창에서 마지막 진술을 남기세요." : "지금은 피고만 발언할 수 있습니다."}</span></div>}
            {game.phase === "verdict" && game.me.alive && !isAccused && <><div><b>도시의 최종 판결</b><span>판결 완료 {game.decision_progress.completed}/{game.decision_progress.total} · 모두 결정하면 자동 집행됩니다.</span></div><button className={game.me.judgement === false ? "secondary-button judgement-selected" : "secondary-button"} aria-pressed={game.me.judgement === false} onClick={() => commitJudgement(false)}><ShieldCheck size={17} />석방</button><button className={game.me.judgement === true ? "danger-button judgement-selected" : "danger-button"} aria-pressed={game.me.judgement === true} onClick={() => commitJudgement(true)}><Gavel size={17} />처형</button></>}
            {game.phase === "verdict" && (!game.me.alive || isAccused) && <div><b>판결 집계 중</b><span>{isAccused ? "도시가 당신의 운명을 결정하고 있습니다." : "생존한 시민의 판결을 기다리고 있습니다."}</span></div>}
            {["reveal", "dawn", "result"].includes(game.phase) && <div><b>{game.story.at(-1)}</b><span>잠시 후 다음 단계로 넘어갑니다.</span></div>}
            {game.phase === "gameover" && <><div><b>{game.winner === "mafia" ? "마피아 팀 승리" : game.winner === "trickster" ? "광대 단독 승리" : "시민 팀 승리"}</b><span>모든 역할이 공개되었습니다.</span></div><button className="secondary-button" onClick={() => setCaseOpen(true)}><BookOpen size={17} />전체 기록</button><button className="secondary-button" onClick={() => createPoster("result")}><Share2 size={17} />사건 리포트</button>{game.host === game.me.id && <button className="primary-button compact" onClick={() => send({ t: "rematch" })}><RotateCcw size={17} />다시 하기</button>}</>}
          </div>
        </section>

        <aside className="comms-panel">
          <div className="story-card">
            <div className="story-card-head"><div className="panel-label">CASE INVESTIGATION</div><button onClick={() => setCaseOpen(true)}><BookOpen size={13} />전체 기록</button></div>
            <div className="ai-director"><div><Radio size={14} /><b>현장 지휘실 · 다음 수사</b><i /></div><p>{game.guide}</p></div>
            <div className="forensic-board">
              <header><Search size={14} /><span><b>현장 감식 단서</b><small>{game.clues.length ? `${game.clues.length}개 확보 · 범인을 포함한 후보군` : "첫 번째 사건 보고를 기다리는 중"}</small></span></header>
              {game.clues.length ? <div>{game.clues.slice(-3).reverse().map((clue) => <article key={clue.id}><span>{clue.code}</span><b>{clue.title}</b><p>{clue.detail}</p><small>{clue.outcome} · DAY {clue.round}</small></article>)}</div> : <p className="forensic-empty">밤의 습격이 발생하면 감식반이 범인을 포함한 용의자 묶음을 공개합니다.</p>}
            </div>
            <div className="story-list">{game.story.slice(-5).map((line, i) => <div key={`${line}-${i}`} className={i === Math.min(4, game.story.length - 1) ? "latest" : ""}><span>{String(Math.max(0, game.story.length - 5) + i + 1).padStart(2, "0")}</span><p>{line}</p></div>)}</div>
            {game.phase === "gameover" && <div className="case-file"><b>사건 파일 · 최종 배역</b><div>{game.players.filter((p) => p.role).map((p) => <span key={p.id}>{p.n} — {p.role ? ROLE_META[p.role].name : "?"} · {p.score}점</span>)}</div></div>}
          </div>
          <div className="chat-card">
            <div className={`voice-chat-bar ${voiceChatOn ? "connected" : ""}`}>
              <div><Headphones size={16} /><span><b>실시간 음성 테이블</b><small>{voiceChatOn ? `${voiceCount}명 연결 · ${voiceCanSpeak ? "발언 가능" : "현재 단계 자동 음소거"}` : "마이크 권한을 허용한 참가자끼리 대화"}</small></span></div>
              <div className="voice-chat-actions">
                {voiceChatOn && <button onClick={() => setMicMuted((muted) => !muted)} disabled={!voiceCanSpeak} aria-label={micMuted ? "마이크 켜기" : "마이크 끄기"}>{micMuted || !voiceCanSpeak ? <MicOff size={15} /> : <Mic size={15} />}</button>}
                <button className={voiceChatOn ? "leave" : "join"} onClick={() => void toggleVoiceChat()}>{voiceChatOn ? <><PhoneOff size={14} />나가기</> : <><Mic size={14} />음성 참여</>}</button>
              </div>
            </div>
            <div className="chat-title"><div><MessageCircle size={16} /><b>{game.phase === "night" && role === "mafia" ? "마피아 비밀 채팅" : game.phase === "day" ? "자유 토론 채널" : "테이블 대화"}</b></div><span>{canChat ? (game.phase === "day" && isCurrentSpeaker ? "집중 발언 중" : "대화 가능") : "침묵 중"}</span></div>
            <div className="chat-scroll">{game.chat.filter((msg) => !msg.from_id || !blockedPlayers.includes(msg.from_id)).length === 0 && <div className="empty-chat">표시할 대화가 없습니다.</div>}{game.chat.filter((msg) => !msg.from_id || !blockedPlayers.includes(msg.from_id)).map((msg) => <div className="chat-message" key={msg.id}><header><b>{msg.from}</b>{msg.from_id && msg.from_id !== game.me.id && <span><button onClick={() => setReportTarget({ id: msg.from_id!, name: msg.from })} aria-label={`${msg.from} 신고`}><Flag size={10} />신고</button><button onClick={() => blockPlayer(msg.from_id!, msg.from)} aria-label={`${msg.from} 차단`}><Ban size={10} />차단</button></span>}</header><p>{msg.text}</p></div>)}<div ref={chatEndRef} /></div>
            {canReact && <div className="reaction-dock" aria-label="빠른 리액션">{REACTION_EMOJIS.map((emoji) => <button key={emoji} onClick={() => send({ t: "react", emoji })} aria-label={`${emoji} 리액션 보내기`}>{emoji}</button>)}</div>}
            <form className="chat-form" onSubmit={submitChat}><input value={chatText} onChange={(e) => setChatText(e.target.value)} disabled={!canChat} placeholder={canChat ? (game.phase === "day" ? "발언 내용은 공개 기록으로 남습니다" : "메시지를 입력하세요") : game.phase === "day" ? "질문은 공개 심문 카드에서 보내세요" : "지금은 말할 수 없습니다"} maxLength={160} /><button disabled={!canChat || !chatText.trim()} aria-label="메시지 전송"><Send size={16} /></button></form>
          </div>
        </aside>
      </div>
      <nav className="mobile-game-nav" aria-label="모바일 게임 메뉴">
        <button className={mobileTab === "case" ? "active" : ""} onClick={() => setMobileTab("case")}><BookOpen size={19} /><span>사건</span>{game.clues.length > 0 && <i>{game.clues.length}</i>}</button>
        <button className={mobileTab === "suspects" ? "active" : ""} onClick={() => setMobileTab("suspects")}><Search size={19} /><span>수사</span></button>
        <button className={mobileTab === "talk" ? "active" : ""} onClick={() => setMobileTab("talk")}><MessageCircle size={19} /><span>대화</span>{game.chat.length > 0 && <i>{Math.min(9, game.chat.length)}</i>}</button>
        <button className={mobileTab === "role" ? "active" : ""} onClick={() => setMobileTab("role")}><ShieldQuestion size={19} /><span>내 정보</span></button>
      </nav>
      {tutorialOpen && <TutorialModal step={tutorialStep} setStep={setTutorialStep} onClose={closeTutorial} />}
      {inviteOpen && <InviteModal room={room} online={game.players.filter((player) => player.connected).length} copied={copied} onClose={() => setInviteOpen(false)} onCopy={copyInvite} onShare={shareInvite} onPoster={() => createPoster("invite")} />}
      {caseOpen && <CaseFileModal game={game} room={room} onClose={() => setCaseOpen(false)} onCopy={copyCaseFile} />}
      {rankingOpen && <RankingModal entries={leaderboard} signedIn={Boolean(identity)} onClose={() => setRankingOpen(false)} />}
      {settingsOpen && <SettingsModal voiceOn={voiceOn} soundOn={soundOn} onVoice={toggleVoice} onSound={toggleSound} onLegal={setLegalPage} onClose={() => setSettingsOpen(false)} />}
      {legalPage && <LegalModal page={legalPage} onClose={() => setLegalPage(null)} />}
      {reportTarget && <ReportModal target={reportTarget.name} reason={reportReason} setReason={setReportReason} onSubmit={submitReport} onBlock={() => { blockPlayer(reportTarget.id, reportTarget.name); setReportTarget(null); }} onClose={() => setReportTarget(null)} />}
      <footer><span>BLACK MIDNIGHT / IMMERSIVE CASE SYSTEM</span><span>실시간 관제 · 역할 작전 지시 · 효과음 · 개인 추리 보드</span></footer>
    </main>
  );
}

function TutorialModal({ step, setStep, onClose }: { step: number; setStep: (step: number) => void; onClose: () => void }) {
  const scene = TUTORIAL_SCENES[step];
  const SceneIcon = scene.icon;
  return (
    <div className="tutorial-backdrop" role="dialog" aria-modal="true" aria-label="게임 규칙 모션 브리핑">
      <div className={`tutorial-film scene-${step + 1}`}>
        <div className="tutorial-city" />
        <div className="tutorial-shade" />
        <button className="tutorial-close" onClick={onClose} aria-label="튜토리얼 닫기"><X size={18} /></button>
        <div className="tutorial-copy">
          <div className="tutorial-icon"><SceneIcon size={26} /></div>
          <span>{scene.tag}</span>
          <h2>{scene.title}</h2>
          <p>{scene.copy}</p>
        </div>
        <div className="tutorial-controls">
          <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}><ChevronLeft size={18} /></button>
          <div>{TUTORIAL_SCENES.map((_, index) => <button key={index} className={index === step ? "active" : ""} onClick={() => setStep(index)} aria-label={`${index + 1}번째 장면`} />)}</div>
          {step < TUTORIAL_SCENES.length - 1 ? <button onClick={() => setStep(step + 1)}><ChevronRight size={18} /></button> : <button className="tutorial-done" onClick={onClose}>게임 시작</button>}
        </div>
      </div>
    </div>
  );
}

function InviteModal({ room, online, copied, onClose, onCopy, onShare, onPoster }: { room: string; online: number; copied: boolean; onClose: () => void; onCopy: () => void; onShare: () => void; onPoster: () => void }) {
  return (
    <div className="invite-backdrop" role="dialog" aria-modal="true" aria-label="친구 초대">
      <div className="invite-modal">
        <button className="invite-close" onClick={onClose} aria-label="친구 초대 닫기"><X size={18} /></button>
        <div className="invite-visual"><div><span>PRIVATE INVITATION</span><b>검은 자정</b><small>{online}명이 자정의 테이블에서 기다리는 중</small></div></div>
        <div className="invite-content">
          <span>ROOM CODE</span>
          <h2>{room}</h2>
          <p>친구는 설치나 가입 없이 링크를 누르고 이름만 정하면 같은 테이블에 바로 앉습니다.</p>
          <button className="primary-button" onClick={onShare}><Share2 size={17} />휴대폰으로 친구 초대</button>
          <div className="invite-actions"><button onClick={onCopy}>{copied ? <Check size={16} /> : <Clipboard size={16} />}{copied ? "복사 완료" : "초대 링크 복사"}</button><button onClick={onPoster}><Download size={16} />초대장 이미지</button></div>
        </div>
      </div>
    </div>
  );
}

function CaseFileModal({ game, room, onClose, onCopy }: { game: GameState; room: string; onClose: () => void; onCopy: () => void }) {
  return (
    <div className="case-backdrop" role="dialog" aria-modal="true" aria-label="전체 사건 기록">
      <section className="case-modal">
        <header><div><span>BLACK MIDNIGHT / ARCHIVE</span><h2>사건 파일</h2><p>ROOM {room} · DAY {game.round || 0}</p></div><button onClick={onClose} aria-label="사건 기록 닫기"><X size={19} /></button></header>
        <div className="case-modal-grid">
          <aside><div className="case-seal"><Gavel size={26} /><span>{game.phase === "gameover" ? "CASE CLOSED" : "ACTIVE CASE"}</span></div><h3>용의자 기록</h3>{game.players.map((player, index) => <div className="case-suspect" key={player.id}><div className={`avatar-photo avatar-${index % 12}`} /><span><b>{player.n}</b><small>{game.phase === "gameover" && player.role ? ROLE_META[player.role].name : player.alive ? "생존 · 신원 미상" : "사망 · 신원 미상"}</small></span><em>{player.score} PTS</em></div>)}</aside>
          <article><div className="case-log-title"><span>FORENSIC EVIDENCE</span><b>{game.clues.length} CLUES</b></div>{game.clues.length > 0 && <div className="case-clue-grid">{game.clues.map((clue) => <div key={clue.id}><span>{clue.code}</span><b>{clue.title}</b><p>{clue.detail}</p><small>{clue.outcome}</small></div>)}</div>}<div className="case-log-title timeline-title"><span>INCIDENT TIMELINE</span><b>{game.case_log.length} RECORDS</b></div><div className="case-log-scroll">{game.case_log.length === 0 && <p className="case-empty">아직 기록된 사건이 없습니다.</p>}{game.case_log.map((line, index) => <div key={`${line}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{line}</p></div>)}</div><button className="secondary-button case-copy" onClick={onCopy}><Clipboard size={16} />전체 사건 기록 복사</button></article>
        </div>
      </section>
    </div>
  );
}

const LEGAL_COPY: Record<LegalPage, { kicker: string; title: string; intro: string; sections: { title: string; body: string }[] }> = {
  terms: { kicker: "TERMS OF SERVICE", title: "이용약관", intro: "검은 자정은 만 14세 이상을 위한 실시간 소셜 추리 게임입니다.", sections: [
    { title: "게임 이용", body: "닉네임과 채팅에 타인의 권리를 침해하는 내용을 사용할 수 없습니다. 게임 진행을 방해하거나 시스템을 악용하면 이용이 제한될 수 있습니다." },
    { title: "사용자 콘텐츠", body: "플레이어는 자신이 전송한 채팅과 음성에 책임을 집니다. 신고된 콘텐츠는 안전한 운영과 분쟁 대응을 위해 검토될 수 있습니다." },
    { title: "서비스 변경", body: "공정성과 안정성을 위해 규칙, 콘텐츠, 운영 정책이 업데이트될 수 있으며 중요한 변경은 앱 또는 저장소에서 알립니다." },
  ] },
  privacy: { kicker: "PRIVACY", title: "개인정보 처리 안내", intro: "게임 진행에 필요한 최소한의 정보만 처리합니다.", sections: [
    { title: "처리 정보", body: "닉네임, 익명 플레이어 식별키, 게임 점수, 신고 내용이 처리됩니다. 음성은 WebRTC로 참가자 사이에 실시간 전송되며 서버에 녹음하거나 저장하지 않습니다." },
    { title: "보관과 삭제", body: "익명 방 상태와 대화는 휘발성 메모리에만 유지되고 방 종료 후 삭제됩니다. 차단 목록과 설정은 사용자의 기기에 저장됩니다." },
    { title: "권한", body: "마이크 권한은 음성 채팅에 참여할 때만 요청합니다. 권한을 거부해도 텍스트 게임은 계속 이용할 수 있습니다." },
  ] },
  community: { kicker: "COMMUNITY SAFETY", title: "커뮤니티 가이드", intro: "거짓말은 역할 안에서만, 존중은 항상 지켜주세요.", sections: [
    { title: "금지 행위", body: "혐오·차별·성적 괴롭힘, 위협, 개인정보 공개, 스팸, 고의적인 게임 방해는 허용되지 않습니다." },
    { title: "신고와 차단", body: "대화 작성자 옆 신고 버튼으로 운영 검토를 요청하고 차단 버튼으로 해당 사용자의 채팅과 음성을 즉시 숨길 수 있습니다." },
    { title: "안전한 플레이", body: "불쾌하거나 위험한 상황에서는 방을 나가고, 현실의 긴급 상황은 지역 응급기관 또는 경찰에 연락하세요." },
  ] },
};

function LegalModal({ page, onClose }: { page: LegalPage; onClose: () => void }) {
  const content = LEGAL_COPY[page];
  return <div className="safety-backdrop" role="dialog" aria-modal="true" aria-label={content.title}><section className="safety-modal"><button className="safety-close" onClick={onClose}><X size={18} /></button><header><FileText size={25} /><small>{content.kicker}</small><h2>{content.title}</h2><p>{content.intro}</p></header><div className="legal-sections">{content.sections.map((section) => <article key={section.title}><b>{section.title}</b><p>{section.body}</p></article>)}</div><button className="primary-button" onClick={onClose}>확인</button></section></div>;
}

function SettingsModal({ voiceOn, soundOn, onVoice, onSound, onLegal, onClose }: { voiceOn: boolean; soundOn: boolean; onVoice: () => void; onSound: () => void; onLegal: (page: LegalPage) => void; onClose: () => void }) {
  return <div className="safety-backdrop" role="dialog" aria-modal="true" aria-label="게임 설정"><section className="safety-modal"><button className="safety-close" onClick={onClose}><X size={18} /></button><header><Settings size={25} /><small>OPERATIONS</small><h2>게임 설정</h2><p>몰입도와 접근성, 운영 정책을 한곳에서 관리합니다.</p></header><div className="settings-list"><button onClick={onVoice}><span><Volume2 size={17} /><b>진행 아나운서</b></span><em>{voiceOn ? "켜짐" : "꺼짐"}</em></button><button onClick={onSound}><span><Radio size={17} /><b>게임 효과음</b></span><em>{soundOn ? "켜짐" : "꺼짐"}</em></button><button onClick={() => onLegal("community")}><span><ShieldCheck size={17} /><b>커뮤니티 가이드</b></span><ChevronRight size={15} /></button><button onClick={() => onLegal("privacy")}><span><LockKeyhole size={17} /><b>개인정보 처리 안내</b></span><ChevronRight size={15} /></button><button onClick={() => onLegal("terms")}><span><FileText size={17} /><b>이용약관</b></span><ChevronRight size={15} /></button></div></section></div>;
}

function ReportModal({ target, reason, setReason, onSubmit, onBlock, onClose }: { target: string; reason: string; setReason: (reason: string) => void; onSubmit: (event: FormEvent) => void; onBlock: () => void; onClose: () => void }) {
  return <div className="safety-backdrop" role="dialog" aria-modal="true" aria-label={`${target} 신고`}><form className="safety-modal report-modal" onSubmit={onSubmit}><button type="button" className="safety-close" onClick={onClose}><X size={18} /></button><header><Flag size={25} /><small>PLAYER SAFETY</small><h2>{target}님 신고</h2><p>신고는 운영 검토 대상으로 접수됩니다. 즉시 보이지 않게 하려면 차단도 함께 사용하세요.</p></header><label>신고 사유<select value={reason} onChange={(event) => setReason(event.target.value)}><option>괴롭힘 또는 혐오 발언</option><option>성적이거나 부적절한 콘텐츠</option><option>개인정보 노출 또는 위협</option><option>스팸 또는 고의적인 게임 방해</option><option>기타 운영 정책 위반</option></select></label><div className="report-actions"><button type="button" className="secondary-button" onClick={onBlock}><Ban size={15} />즉시 차단</button><button className="danger-button"><Flag size={15} />신고 접수</button></div></form></div>;
}

function RankingModal({ entries, signedIn, onClose }: { entries: LeaderboardEntry[]; signedIn: boolean; onClose: () => void }) {
  return (
    <div className="ranking-backdrop" role="dialog" aria-modal="true" aria-label="명예의 전당">
      <section className="ranking-modal">
        <button className="ranking-close" onClick={onClose} aria-label="랭킹 닫기"><X size={19} /></button>
        <header><Trophy size={28} /><span>BLACK MIDNIGHT / SEASON RANKING</span><h2>명예의 전당</h2><p>로그인 플레이어의 최고 사건 점수가 기록됩니다.</p></header>
        <div className="ranking-list">{entries.length === 0 && <div className="ranking-empty">아직 기록된 요원이 없습니다.<br />첫 번째 사건을 해결해 이름을 남겨보세요.</div>}{entries.slice(0, 10).map((entry, index) => <div className={index < 3 ? `podium rank-${index + 1}` : ""} key={`${entry.name}-${index}`}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{entry.name}</strong><small>{new Date(entry.updated_at).toLocaleDateString("ko-KR")} 갱신</small></span><em>{entry.best_score} PTS</em></div>)}</div>
        {!signedIn && <a className="ranking-signin" href={signInHref()}>로그인하고 내 최고 점수 기록하기</a>}
      </section>
    </div>
  );
}

function PlayerCard({ player, index, self, host, accused, selected, selectable, mark, phase, onSelect }: { player: PlayerState; index: number; self: boolean; host: boolean; accused: boolean; selected: boolean; selectable: boolean; mark: -1 | 0 | 1; phase: GameState["phase"]; onSelect: () => void }) {
  return (
    <button type="button" className={`player-card ${!player.alive ? "dead" : ""} ${accused ? "accused" : ""} ${selected ? "selected" : ""} ${selectable ? "selectable" : ""}`} onClick={selectable ? onSelect : undefined} disabled={!selectable}>
      <div className="portrait"><span>{String(index + 1).padStart(2, "0")}</span><b className={`avatar-photo avatar-${index % 12}`} aria-label={`${player.n} 가상 인물 사진`} />{player.connected && <i />}{mark !== 0 && <em className={`intel-mark ${mark === -1 ? "suspect" : "safe"}`}>{mark === -1 ? "의심" : "안전"}</em>}</div>
      <div className="player-info"><div><strong>{player.n}</strong>{self && <small>나</small>}{host && <small>방장</small>}{player.bot && <small>AI</small>}{player.voice && <Mic className="voice-presence-icon" size={12} />}{player.mafia && <Skull size={13} />}{player.id && phase === "gameover" && player.role && <small>{ROLE_META[player.role].name}</small>}</div><span>{!player.alive ? "사망" : phase === "lobby" ? host ? "시작 권한 보유" : player.ready ? "준비 완료" : "대기 중" : "생존"}</span></div>
      {player.votes > 0 && <div className="vote-count">{player.votes}표</div>}
      {accused && <div className="accused-mark"><Gavel size={12} />피고</div>}
      {selected && <div className="selected-mark"><Check size={14} /></div>}
    </button>
  );
}
