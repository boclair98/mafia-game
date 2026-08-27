"use client";

import {
  Activity, Award, Ban, Bot, BookOpen, Check, ChevronLeft, ChevronRight, Clipboard, Crosshair, Download, Eye, FileText, Film, Flag, Gavel,
  Headphones, HeartPulse, Link2, LockKeyhole, LogIn, MessageCircle, Mic, MicOff, Moon, PhoneOff, Radio, RotateCcw, Search, Send, Siren,
  Settings, Share2, ShieldCheck, ShieldQuestion, Skull, Smartphone, Sparkles,
  TimerReset, Trophy, UserPlus, Users, Volume2, Vote, X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GameState, PlayerState, Role, WelcomeMsg } from "@/lib/game";
import { fetchGameStatus, fetchLeaderboard, type GameStatus, type LeaderboardEntry } from "@/lib/api";
import { signInHref, useMe } from "@/lib/identity";
import { getActiveChapter, getCaseNarrative, getEndingLine, getNarrativeLine, type CaseNarrative } from "@/lib/narrative";
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
type JoinMode = "party" | "solo" | "first";

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
  if (phase === "gameover") return getEndingLine(game);
  if (phase === "reveal") {
    const role = ROLE_META[game.me.role];
    return `사건이 시작되었습니다. 당신은 ${role.name}입니다. ${role.goal}. ${role.power}.`;
  }
  if ((phase === "dawn" || phase === "result") && latest) {
    return phase === "dawn" ? `새벽 사건 보고입니다. ${latest}` : `판결 결과입니다. ${latest}`;
  }
  if (phase === "defense" && accused) return `${accused.n}님의 최후 변론을 시작합니다.`;
  if (phase === "day" && game.me.can_theorize) {
    return "낮 토론이 시작되었습니다. 공개 단서와 당신의 시간 조각을 연결해 증거 고리를 봉인하세요.";
  }
  return getNarrativeLine({ ...game, phase }) || PHASE_NARRATION[phase];
}

const PHASE_TRACK: GameState["phase"][] = ["reveal", "night", "dawn", "day", "vote", "defense", "verdict", "result"];
const PHASE_THREAT: Record<GameState["phase"], number> = { lobby: 8, reveal: 24, night: 72, dawn: 58, day: 42, vote: 82, defense: 88, verdict: 96, result: 94, gameover: 100 };
const REACTION_EMOJIS = ["👀", "⚠️", "👍", "🤥", "❓", "🩸"];
const VOICE_PREF_KEY = "black-midnight:voice-v2";
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

function makeRoom(mode: JoinMode = "party") {
  const left = ["silent", "black", "hidden", "last", "red"];
  const right = ["moon", "alley", "hotel", "signal", "midnight"];
  const prefix = mode === "first" ? "first-" : mode === "solo" ? "solo-" : "";
  return `${prefix}${left[Math.floor(Math.random() * left.length)]}-${right[Math.floor(Math.random() * right.length)]}-${Math.floor(100 + Math.random() * 900)}`;
}

function getPlayerKey(room: string) {
  const storageKey = `black-midnight:${room}`;
  let key = localStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(storageKey, key);
  }
  return key;
}

function secondsLeft(deadline: number, now: number) {
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}

export default function GamePage() {
  const identity = useMe();
  const socketRef = useRef<GameSocket | null>(null);
  const receivedPhaseRef = useRef<GameState["phase"] | null>(null);
  const soloLaunchRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [joined, setJoined] = useState(false);
  const [nick, setNick] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [joinMode, setJoinMode] = useState<JoinMode>("party");
  const [room, setRoom] = useState("");
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [welcome, setWelcome] = useState<WelcomeMsg | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [chatText, setChatText] = useState("");
  const [questionText, setQuestionText] = useState("");
  const [claimText, setClaimText] = useState("");
  const [tipText, setTipText] = useState("");
  const [willText, setWillText] = useState("");
  const [memoryText, setMemoryText] = useState("");
  const [sceneOrder, setSceneOrder] = useState<string[]>([]);
  const [theoryTarget, setTheoryTarget] = useState<string | null>(null);
  const [theoryClueId, setTheoryClueId] = useState<string | null>(null);
  const [theoryFragmentId, setTheoryFragmentId] = useState<string | null>(null);
  const [theoryStake, setTheoryStake] = useState<1 | 2>(1);
  const [oathTarget, setOathTarget] = useState<string | null>(null);
  const [oathText, setOathText] = useState("");
  const [contractTarget, setContractTarget] = useState<string | null>(null);
  const [contractText, setContractText] = useState("");
  const [ghostText, setGhostText] = useState("");
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
  const [joinOpen, setJoinOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [caseOpen, setCaseOpen] = useState(false);
  const [rankingOpen, setRankingOpen] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [networkStatus, setNetworkStatus] = useState<GameStatus | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [voiceChatOn, setVoiceChatOn] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [legalPage, setLegalPage] = useState<LegalPage | null>(null);
  const [reportTarget, setReportTarget] = useState<{ id: string; name: string } | null>(null);
  const [reportReason, setReportReason] = useState("괴롭힘 또는 혐오 발언");
  const [blockedPlayers, setBlockedPlayers] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Record<string, -1 | 0 | 1>>({});
  const [mobileTab, setMobileTab] = useState<"case" | "suspects" | "talk" | "role">("suspects");
  const [seenChatCount, setSeenChatCount] = useState(0);
  const [phaseAlert, setPhaseAlert] = useState<GameState["phase"] | null>(null);
  const [decisionFlash, setDecisionFlash] = useState<{ label: string; target: string } | null>(null);
  const [ballotReveal, setBallotReveal] = useState<{ entries: GameState["ballot_feed"]; visible: number } | null>(null);
  const [eventReveal, setEventReveal] = useState<GameState["round_event"]>(null);
  const previousPhase = useRef<string | null>(null);
  const previousEvent = useRef<string | null>(null);
  const phaseAlertTimer = useRef<number | null>(null);
  const ballotRevealTimer = useRef<number | null>(null);
  const decisionFlashTimer = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const voiceRoomRef = useRef<VoiceRoom | null>(null);
  const lastCountdownBeep = useRef<number | null>(null);
  const speechGenerationRef = useRef(0);
  const soundPhase = game?.phase;
  const countdownRemaining = game ? secondsLeft(game.deadline, now) : 0;
  const narrationText = game && soundPhase ? phaseNarration(game, soundPhase) : "";
  const roundEventId = game?.round_event?.id ?? null;
  const roundEventTitle = game?.round_event?.title ?? "";
  const roundEventTag = game?.round_event?.tag ?? "";
  const roundEventCopy = game?.round_event?.copy ?? "";
  const roundEventSealed = game?.round_event?.sealed_pressure ?? false;
  const eventSpeechKey = game?.phase === "lobby" ? null : roundEventId;
  const latestTipId = game?.phase === "day"
    ? game.tips.filter((tip) => tip.round === game.round).at(-1)?.id ?? null
    : null;
  const voiceCanSpeak = Boolean(game?.me.alive && (
    ["lobby", "day", "vote", "gameover"].includes(game.phase)
    || (game.phase === "defense" && game.me.id === game.accused_id)
  ));
  const voicePeerKey = game?.players.filter((player) => player.voice && !player.bot && player.id !== game.me.id && !blockedPlayers.includes(player.id)).map((player) => player.id).sort().join("|") ?? "";
  const myVoicePresent = game?.players.find((player) => player.id === game.me.id)?.voice ?? false;
  const unreadChatCount = mobileTab === "talk" ? 0 : Math.max(0, (game?.chat.length ?? 0) - seenChatCount);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      const requestedRoom = params.get("room") || "";
      const requestedMode: JoinMode = params.get("mode") === "first" || requestedRoom.startsWith("first-") ? "first" : params.get("mode") === "solo" || requestedRoom.startsWith("solo-") ? "solo" : "party";
      setJoinMode(requestedMode);
      setRoomInput(requestedRoom || makeRoom(requestedMode));
      setInvitedByLink(Boolean(requestedRoom));
      setNick(localStorage.getItem("black-midnight:nick") || "");
      const savedStats = localStorage.getItem("black-midnight:stats");
      if (savedStats) {
        try { setStats(JSON.parse(savedStats) as LocalStats); } catch { localStorage.removeItem("black-midnight:stats"); }
      }
      // Audio is part of the core case experience by default. v2 deliberately
      // ignores the old opt-out key so returning players get the new default;
      // a new explicit mute choice is still persisted below.
      setVoiceOn(localStorage.getItem(VOICE_PREF_KEY) !== "0");
      setSoundOn(localStorage.getItem("black-midnight:sound") !== "0");
      setTermsAccepted(localStorage.getItem("black-midnight:terms-v1") === "1");
      try { setBlockedPlayers(JSON.parse(localStorage.getItem("black-midnight:blocked") || "[]") as string[]); } catch { localStorage.removeItem("black-midnight:blocked"); }
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw-v6.js").catch(() => undefined);
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
    const modalOpen = joinOpen || tutorialOpen || inviteOpen || caseOpen || rankingOpen || settingsOpen || Boolean(legalPage) || Boolean(reportTarget);
    if (!modalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeTopModal = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (joinOpen) setJoinOpen(false);
      else if (caseOpen) setCaseOpen(false);
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
  }, [caseOpen, inviteOpen, joinOpen, legalPage, rankingOpen, reportTarget, settingsOpen, tutorialOpen]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [game?.chat.length]);

  useEffect(() => {
    if (!game) return;
    const changed = previousPhase.current ? previousPhase.current !== game.phase : game.phase !== "lobby";
    if (changed) {
      lastCountdownBeep.current = null;
      setPhaseAlert(game.phase);
      setSelected(game.phase === "night" ? game.me.action_target : game.phase === "vote" ? game.me.vote_target : null);
      setMobileTab(
        game.phase === "reveal" ? "role"
          : ["day", "defense"].includes(game.phase) ? "talk"
            : ["dawn", "result", "gameover"].includes(game.phase) ? "case"
              : "suspects",
      );
      if (phaseAlertTimer.current) window.clearTimeout(phaseAlertTimer.current);
      // Keep the director card on screen long enough to read the objective,
      // hear the announcer, and find the matching action tab.
      phaseAlertTimer.current = window.setTimeout(() => setPhaseAlert(null), 7000);
      if (ballotRevealTimer.current) window.clearTimeout(ballotRevealTimer.current);
      if (game.phase === "defense" && game.ballot_feed.length) {
        ballotRevealTimer.current = window.setTimeout(() => setBallotReveal({ entries: game.ballot_feed, visible: 0 }), 6500);
      }
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

  useEffect(() => {
    if (game?.phase === "lobby") {
      previousEvent.current = null;
      queueMicrotask(() => setEventReveal(null));
      return;
    }
    if (!roundEventId || previousEvent.current === roundEventId) return;
    const event: NonNullable<GameState["round_event"]> = {
      id: roundEventId,
      title: roundEventTitle,
      tag: roundEventTag,
      copy: roundEventCopy,
      sealed_pressure: roundEventSealed,
    };
    previousEvent.current = roundEventId;
    // Let the phase director finish first; the round event is the second
    // beat, not a competing overlay that hides the objective card.
    const showTimer = window.setTimeout(() => setEventReveal(event), 7800);
    const hideTimer = window.setTimeout(() => setEventReveal(null), 15600);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
  }, [game?.phase, roundEventCopy, roundEventId, roundEventSealed, roundEventTag, roundEventTitle]);

  useEffect(() => () => {
    if (phaseAlertTimer.current) window.clearTimeout(phaseAlertTimer.current);
    if (ballotRevealTimer.current) window.clearTimeout(ballotRevealTimer.current);
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

  const speakLine = useCallback((text: string, interrupt = true) => {
    if (!voiceOn || !text.trim() || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const generation = speechGenerationRef.current + 1;
    speechGenerationRef.current = generation;
    if (interrupt) synth.cancel();
    let spoken = false;
    const play = () => {
      if (spoken || generation !== speechGenerationRef.current) return;
      spoken = true;
      const line = new SpeechSynthesisUtterance(text.trim());
      const koreanVoices = synth.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith("ko"));
      line.voice = koreanVoices.find((voice) => /(injoon|hyunsu|male|남성|natural|neural)/i.test(voice.name))
        ?? koreanVoices.find((voice) => /(google|microsoft|apple)/i.test(voice.name))
        ?? koreanVoices[0]
        ?? null;
      line.lang = "ko-KR";
      line.rate = 0.88;
      line.pitch = 0.78;
      line.volume = 0.96;
      synth.speak(line);
    };
    if (synth.getVoices().length > 0) {
      try { synth.resume(); } catch { /* some browsers expose a no-op resume */ }
      play();
      return;
    }
    const onVoicesChanged = () => {
      synth.removeEventListener("voiceschanged", onVoicesChanged);
      try { synth.resume(); } catch { /* some browsers expose a no-op resume */ }
      play();
    };
    synth.addEventListener("voiceschanged", onVoicesChanged);
    window.setTimeout(() => {
      synth.removeEventListener("voiceschanged", onVoicesChanged);
      play();
    }, 300);
  }, [voiceOn]);

  useEffect(() => {
    if (!voiceOn || !soundPhase || !narrationText || !("speechSynthesis" in window)) return;
    // A phase announcement is the director's hand-off. Cancel an older line
    // before speaking the new one so browser-specific speech queues cannot
    // overlap or make the current phase sound like it was cut in half.
    speakLine(narrationText, true);
    return () => {
      speechGenerationRef.current += 1;
    };
  }, [narrationText, soundPhase, speakLine, voiceOn]);

  useEffect(() => {
    if (!voiceOn || !eventSpeechKey || !roundEventTitle || !roundEventCopy) return;
    const timer = window.setTimeout(() => {
      speakLine(`자정 사건 카드. ${roundEventTitle}. ${roundEventCopy}`, false);
    }, 3600);
    return () => window.clearTimeout(timer);
  }, [eventSpeechKey, roundEventCopy, roundEventTitle, speakLine, voiceOn]);

  useEffect(() => {
    if (!voiceOn || !latestTipId) return;
    const timer = window.setTimeout(() => {
      speakLine("익명 제보가 도착했습니다. 작성자는 공개되지 않습니다. 사건 기록에서 내용을 확인하세요.", false);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [latestTipId, speakLine, voiceOn]);

  useEffect(() => {
    if (!joined || !room || !nick) return;
    receivedPhaseRef.current = null;
    const key = getPlayerKey(room);
    const socket = new GameSocket(gameSocketUrl(room, nick, key), {
      onStatus: setStatus,
      onFatal: (reason) => {
        setWelcome(null);
        setGame(null);
        setJoined(false);
        setNotice(reason === "room_full" ? "이 방은 정원이 가득 찼습니다. 다른 사건 코드를 선택해 주세요." : reason === "solo_room" ? "혼자 수사 전용 방입니다. 친구와 플레이하려면 친구 방을 새로 만들어 주세요." : "방장이 좌석을 정리했습니다. 새 사건에 다시 합류해 주세요.");
        window.setTimeout(() => setNotice(""), 4800);
      },
      onMessage: (raw) => {
        const msg = raw as WelcomeMsg | GameState | { t: "error" | "notice"; message: string } | { t: "voice_signal"; from: string; data: VoiceSignal };
        if (msg.t === "welcome") {
          setWelcome(msg as WelcomeMsg);
        } else if (msg.t === "state") {
          const next = msg as GameState;
          const phaseChanged = receivedPhaseRef.current !== next.phase;
          receivedPhaseRef.current = next.phase;
          setGame({
            ...next,
            players: next.players.map((player) => ({ ...player, score: player.score ?? 0, voice: player.voice ?? false })),
            round_event: next.round_event ?? null,
            tips: next.tips ?? [],
            pressure_counts: next.pressure_counts ?? {},
            pressure_progress: next.pressure_progress ?? { completed: 0, total: 0, sealed: false },
             awards: next.awards ?? [],
             case_mode: next.case_mode ?? (next.lobby_mode === "first" ? "first" : "classic"),
             case_grade: next.case_grade ?? "",
             case_badges: next.case_badges ?? [],
             final_highlights: next.final_highlights ?? [],
             best_persuader: next.best_persuader ?? null,
             ai_social: next.ai_social ?? [],
             contracts: next.contracts ?? [],
            accused_id: next.accused_id ?? null,
            judgement_counts: next.judgement_counts ?? { execute: 0, spare: 0 },
            ballot_feed: next.ballot_feed ?? [],
            clues: next.clues ?? [],
            public_leads: next.public_leads ?? [],
            memory_reveals: next.memory_reveals ?? [],
            scene_progress: next.scene_progress ?? { completed: 0, total: 0 },
            theory_board: next.theory_board ?? [],
            oaths: next.oaths ?? [],
            ghost_echoes: next.ghost_echoes ?? [],
            director_beats: next.director_beats ?? [],
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
              can_tip: next.me.can_tip ?? false,
              can_leave_will: next.me.can_leave_will ?? false,
              private_lead: next.me.private_lead ?? null,
              ghost_prediction: next.me.ghost_prediction ?? null,
              ghost_correct: next.me.ghost_correct ?? null,
              pressure_target: next.me.pressure_target ?? null,
              mission_completed: next.me.mission_completed ?? false,
              memory_prompt: next.me.memory_prompt ?? "사건 직전 마지막으로 본 사람과 장소를 기록하세요.",
              memory_seal: next.me.memory_seal ?? null,
              can_seal_memory: next.me.can_seal_memory ?? false,
              scene_fragments: next.me.scene_fragments ?? [],
              scene_result: next.me.scene_result ?? null,
              can_reconstruct: next.me.can_reconstruct ?? false,
              theory: next.me.theory ?? null,
              theory_stakes: next.me.theory_stakes ?? 0,
              can_theorize: next.me.can_theorize ?? false,
              oath_target: next.me.oath_target ?? null,
              oath_text: next.me.oath_text ?? "",
              can_oath: next.me.can_oath ?? false,
              can_ghost_message: next.me.can_ghost_message ?? false,
              ghost_message: next.me.ghost_message ?? null,
            },
          });
          if (phaseChanged) {
            setSceneOrder([]);
            setTheoryTarget(null);
            setTheoryClueId(null);
            setTheoryFragmentId(null);
            setTheoryStake(1);
            setOathTarget(next.me.oath_target ?? null);
            setOathText("");
            setContractTarget(null);
            setContractText("");
            setGhostText("");
          }
          setSelected((current) => {
            if (phaseChanged) {
              if (next.phase === "night") return next.me.action_target ?? null;
              if (next.phase === "vote") return next.me.vote_target ?? null;
              return null;
            }
            return current && next.players.some((p) => p.id === current && p.alive) ? current : null;
          });
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

  // A solo room is a deliberate one-tap path: once the socket confirms the
  // lobby, the host immediately asks the server to seat the AI cast and start
  // the case. Party rooms keep the ready/invite flow unchanged.
  useEffect(() => {
    if (!joined || !["solo", "first"].includes(joinMode) || !game || game.phase !== "lobby" || game.host !== game.me.id) return;
    if (soloLaunchRef.current) return;
    soloLaunchRef.current = true;
    const timer = window.setTimeout(() => {
      if (!socketRef.current?.send({ t: joinMode === "first" ? "first_start" : "solo_start" })) soloLaunchRef.current = false;
    }, 220);
    return () => window.clearTimeout(timer);
  }, [game, joined, joinMode]);

  // The landing page is intentionally long. When a player opens the join
  // sheet from its lower CTA, browsers preserve the old scroll offset while
  // replacing the landing tree with the game tree. Always start the case at
  // the top so the room header and phase director are immediately visible.
  useEffect(() => {
    if (!joined) return;
    const reset = () => {
      window.scrollTo(0, 0);
      const shell = document.querySelector<HTMLElement>(".game-shell");
      if (shell) shell.scrollTop = 0;
    };
    const frame = window.requestAnimationFrame(reset);
    return () => window.cancelAnimationFrame(frame);
  }, [joined, room]);

  useEffect(() => {
    if (!ballotReveal) return;
    if (ballotReveal.visible < ballotReveal.entries.length) {
      const timer = window.setTimeout(() => setBallotReveal((current) => current ? { ...current, visible: current.visible + 1 } : null), 550);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setBallotReveal(null), 900);
    return () => window.clearTimeout(timer);
  }, [ballotReveal]);

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
    let safeRoom = roomInput.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || makeRoom(joinMode);
    if (joinMode === "first" && !safeRoom.startsWith("first-")) safeRoom = `first-${safeRoom}`.slice(0, 32);
    if (joinMode === "solo" && !safeRoom.startsWith("solo-")) safeRoom = `solo-${safeRoom}`.slice(0, 32);
    if (!safeNick || !termsAccepted) return;
    localStorage.setItem("black-midnight:terms-v1", "1");
    localStorage.setItem("black-midnight:nick", safeNick);
    const query = new URLSearchParams({ room: safeRoom });
    if (joinMode !== "party") query.set("mode", joinMode);
    history.replaceState(null, "", `?${query.toString()}`);
    soloLaunchRef.current = false;
    setNick(safeNick);
    setRoom(safeRoom);
    setJoined(true);
  };

  const cancelJoin = () => {
    socketRef.current?.close();
    socketRef.current = null;
    soloLaunchRef.current = false;
    setJoined(false);
    setWelcome(null);
    setGame(null);
    setStatus("connecting");
    setNotice("입장을 취소했습니다. 방 코드를 확인한 뒤 다시 시도해 주세요.");
    window.setTimeout(() => setNotice(""), 3200);
  };

  const send = (message: object) => {
    const sent = socketRef.current?.send(message) ?? false;
    if (!sent) {
      setNotice("연결을 복구하는 중입니다. 입력은 전송되지 않았으니 연결 후 다시 시도해 주세요.");
      window.setTimeout(() => setNotice(""), 3200);
    }
    return sent;
  };
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
  const caseNarrative: CaseNarrative | null = game ? getCaseNarrative(game.case_profile.id) : null;
  const activeChapter = game ? getActiveChapter(game) : null;
  const narrativeLine = game ? getNarrativeLine(game) : "";
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
    : game.phase === "day" ? (game.me.can_theorize ? "모두 자유롭게 토론합니다. 공개 단서와 내 시간 조각을 연결해 증거 고리를 봉인하세요." : "모두 자유롭게 토론합니다. 집중 발언자의 모순과 봉인된 증거 고리를 함께 비교하세요.")
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
    localStorage.setItem(VOICE_PREF_KEY, next ? "1" : "0");
    if (!next) {
      speechGenerationRef.current += 1;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    }
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
    if (!send({ t: kind, target: selectedPlayer.id })) return;
    const label = kind === "vote" ? "투표 봉인 완료" : `${refinedActionCopy} 선택 완료`;
    setDecisionFlash({ label, target: selectedPlayer.n });
    speakLine(kind === "vote"
      ? `${selectedPlayer.n}님에게 투표를 봉인했습니다.`
      : `${selectedPlayer.n}님을 대상으로 ${refinedActionCopy}을 봉인했습니다.`, false);
    if (decisionFlashTimer.current) window.clearTimeout(decisionFlashTimer.current);
    decisionFlashTimer.current = window.setTimeout(() => setDecisionFlash(null), 2600);
    if ("vibrate" in navigator) navigator.vibrate(kind === "vote" ? [45, 30, 90] : 60);
  };

  const commitJudgement = (execute: boolean) => {
    if (!send({ t: "judge", execute })) return;
    setDecisionFlash({ label: execute ? "처형 판결 봉인" : "석방 판결 봉인", target: accusedPlayer?.n ?? "피고" });
    speakLine(`${accusedPlayer?.n ?? "피고"}님을 ${execute ? "처형하는" : "석방하는"} 판결로 봉인했습니다.`, false);
    if (decisionFlashTimer.current) window.clearTimeout(decisionFlashTimer.current);
    decisionFlashTimer.current = window.setTimeout(() => setDecisionFlash(null), 2600);
    if ("vibrate" in navigator) navigator.vibrate(execute ? [45, 30, 90] : 55);
  };

  const submitChat = (event: FormEvent) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    if (!send({ t: "chat", text })) return;
    setChatText("");
  };

  const submitQuestion = (event: FormEvent) => {
    event.preventDefault();
    const text = questionText.trim();
    if (!text || !currentSpeaker) return;
    if (!send({ t: "question", text })) return;
    setQuestionText("");
  };

  const submitClaim = (event: FormEvent) => {
    event.preventDefault();
    const text = claimText.trim();
    if (!text) return;
    if (!send({ t: "claim", text })) return;
    setClaimText("");
  };

  const submitTip = (event: FormEvent) => {
    event.preventDefault();
    const text = tipText.trim();
    if (!text || !game?.me.can_tip) return;
    if (!send({ t: "tip", text })) return;
    setTipText("");
  };

  const submitWill = (event: FormEvent) => {
    event.preventDefault();
    const text = willText.trim();
    if (!text) return;
    if (!send({ t: "will", text })) return;
    setWillText("");
  };

  const submitMemory = (event: FormEvent) => {
    event.preventDefault();
    const text = memoryText.trim();
    if (!text || !game?.me.can_seal_memory) return;
    if (!send({ t: "memory_seal", text })) return;
    setMemoryText("");
  };

  const submitOath = (event: FormEvent) => {
    event.preventDefault();
    if (!game?.me.can_oath || !oathTarget) return;
    if (!send({ t: "oath", target: oathTarget, text: oathText.trim() })) return;
    setOathText("");
  };

  const submitContract = (event: FormEvent) => {
    event.preventDefault();
    if (!contractTarget || contractText.trim().length < 5 || game?.contracts?.some((item) => item.owner_id === game.me.id && item.round === game.round)) return;
    if (!send({ t: "contract", target: contractTarget, text: contractText.trim() })) return;
    setContractText("");
  };

  const submitGhostEcho = (event: FormEvent) => {
    event.preventDefault();
    const text = ghostText.trim();
    if (!text || !game?.me.can_ghost_message) return;
    if (!send({ t: "ghost_echo", text })) return;
    setGhostText("");
  };

  const submitScene = () => {
    if (!game?.me.can_reconstruct || sceneOrder.length < 2) return;
    send({ t: "reconstruct", order: sceneOrder });
  };

  const submitTheory = (event: FormEvent) => {
    event.preventDefault();
    if (!game?.me.can_theorize || !theoryTarget || !theoryClueId || !theoryFragmentId) return;
    if (!send({ t: "theory", target: theoryTarget, clue_id: theoryClueId, fragment_id: theoryFragmentId, stake: theoryStake })) return;
    setTheoryTarget(null);
    setTheoryClueId(null);
    setTheoryFragmentId(null);
    setTheoryStake(1);
    speakLine("증거 연결 고리를 봉인했습니다. 진실은 사건 종료 후 검증됩니다.", false);
  };

  const copyCaseFile = async () => {
    if (!game) return;
    const roles = game.players.filter((player) => player.role).map((player) => `${player.n} — ${ROLE_META[player.role!].name} · ${player.score}점`).join("\n");
    const clues = game.clues.map((clue) => `${clue.code} ${clue.title} — ${clue.detail}`).join("\n");
    const theories = game.theory_board.map((theory) => {
      const verdict = theory.status ? ` · ${theory.status} ${theory.matched_links ?? 0}/${theory.total_links ?? 3}` : " · 검증 대기";
      return `DAY ${theory.round} · ${theory.owner} → ${theory.target} · ${theory.clue_code} ${theory.clue_title} + ${theory.fragment_time} ${theory.fragment_title} · 인장 ${theory.stake}${verdict}`;
    }).join("\n");
    const tips = game.tips.map((tip) => `DAY ${tip.round} · 익명 제보 — ${tip.text}`).join("\n");
    const history = game.case_log.map((line, index) => `${String(index + 1).padStart(2, "0")}  ${line}`).join("\n");
    await navigator.clipboard.writeText(`[검은 자정 · ${room}]\n${roles}\n\n현장 단서\n${clues || "아직 확보된 단서 없음"}\n\n증거 연결 고리\n${theories || "봉인된 가설 없음"}\n\n익명 제보\n${tips || "도착한 익명 제보 없음"}\n\n사건 기록\n${history}`);
    setNotice("전체 사건 기록을 복사했습니다.");
  };

  const chooseJoinMode = (mode: JoinMode) => {
    setJoinMode(mode);
    if (!invitedByLink) setRoomInput(makeRoom(mode));
  };

  const focusJoinCard = (mode: JoinMode = "party") => {
    chooseJoinMode(mode);
    setJoinOpen(true);
    window.setTimeout(() => document.querySelector<HTMLInputElement>("#landing-nick")?.focus(), 180);
  };

  const landingSceneMeta = LANDING_SCENES[landingScene];
  const LandingSceneIcon = landingSceneMeta.icon;
  const landingRoleMeta = LANDING_ROLES[landingRole];

  if (!joined) {
    return (
      <main className="landing-shell">
        <div className="grain" />
        {notice && <div className="toast">{notice}</div>}
        <header className="campaign-nav">
          <button className="campaign-brand" type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><span>BLACK MIDNIGHT</span><b>검은 자정</b></button>
          <nav aria-label="게임 안내">
            <button type="button" onClick={() => document.querySelector("#case-world")?.scrollIntoView({ behavior: "smooth" })}>게임 소개</button>
            <button type="button" onClick={() => { setTutorialStep(0); setTutorialOpen(true); }}>플레이 가이드</button>
            <button type="button" onClick={() => setRankingOpen(true)}>기록 보관소</button>
          </nav>
          <div className="campaign-status"><i />{networkStatus ? `${networkStatus.players}명 수사 중` : "LIVE"}</div>
          <button className="campaign-settings" onClick={() => setSettingsOpen(true)} aria-label="설정과 운영 정책"><Settings size={18} /></button>
        </header>

        <section className="campaign-hero">
          <div className="campaign-hero-shade" aria-hidden="true" />
          <div className="campaign-case-mark"><span>CASE FILE</span><b>NO. 042</b></div>
          <div className="campaign-hero-copy">
            <span className="campaign-overline">INTERACTIVE MURDER MYSTERY</span>
            <p className="campaign-date">자정 00:42 · 밀실에 남겨진 일곱 개의 거짓말</p>
            <h1><span>검은</span><em>자정</em></h1>
            <p className="campaign-tagline">한 명이 죽었다.<br />범인은 아직 이 방 안에 있다.</p>
            <button className="campaign-play" type="button" onClick={() => { setTutorialStep(0); setTutorialOpen(true); }} aria-label="30초 사건 브리핑 재생"><span><Film size={22} /></span><b>30초 사건 브리핑</b></button>
            <div className="campaign-actions">
              <button className="campaign-primary" type="button" onClick={() => focusJoinCard(invitedByLink ? joinMode : "party")}><span>{invitedByLink ? "초대받은 사건에 합류" : "친구와 함께 사건 시작"}</span><ChevronRight size={19} /></button>
              <button className="campaign-secondary campaign-solo" type="button" onClick={() => focusJoinCard("solo")}><Bot size={17} />혼자 수사 · AI 7명</button>
              <button className="campaign-secondary campaign-first" type="button" onClick={() => focusJoinCard("first")}><BookOpen size={17} />첫 사건 · 8–12분</button>
              <button className="campaign-secondary" type="button" onClick={() => focusJoinCard("party")}><Users size={17} />친구 방 코드로 합류</button>
            </div>
            <div className="campaign-proof"><span><Check size={12} />설치 없이 시작</span><span><Mic size={12} />실시간 음성</span><span><Users size={12} />4–12인 추리</span></div>
          </div>
          <button className="campaign-scroll" type="button" onClick={() => document.querySelector("#case-world")?.scrollIntoView({ behavior: "smooth" })}><span>사건 속으로</span><ChevronRight size={16} /></button>
        </section>

        <section className="campaign-world" id="case-world">
          <div className="campaign-section-heading"><span>THE NIGHT BEGINS</span><h2>당신의 한마디가<br />사건의 결말을 바꾼다</h2><p>정답을 고르는 게임이 아닙니다. 단서를 읽고, 목소리를 듣고, 누군가의 거짓말을 끝까지 추적하세요.</p></div>
          <div className="campaign-scene-grid">
            {LANDING_SCENES.map((scene, index) => {
              const SceneIcon = scene.icon;
              return <button type="button" key={scene.tag} className={index === landingScene ? "active" : ""} onClick={() => setLandingScene(index)}><span className="campaign-scene-no">0{index + 1}</span><SceneIcon size={24} /><small>{scene.tag}</small><b>{scene.title}</b><p>{scene.copy}</p><i /></button>;
            })}
          </div>
          <div key={landingSceneMeta.tag} className="campaign-live-line" aria-live="polite"><LandingSceneIcon size={18} /><span><small>LIVE CASE · {landingSceneMeta.tag}</small><b>{landingSceneMeta.title}</b></span><p>{landingSceneMeta.copy}</p></div>
        </section>

        <section className="campaign-roles">
          <div className="campaign-section-heading"><span>TRUST NO ONE</span><h2>누구로 깨어날지는<br />봉인을 열기 전까지 모른다</h2></div>
          <div className="campaign-role-grid">{LANDING_ROLES.map((item, index) => <button type="button" key={item.code} className={index === landingRole ? "active" : ""} onClick={() => setLandingRole(index)}><small>{item.code}</small><span>0{index + 1}</span><b>{item.name}</b><em>{item.tagline}</em></button>)}</div>
          <div className="campaign-role-brief"><span><LockKeyhole size={15} />{landingRoleMeta.name} · 봉인된 생존 지침</span><p>{landingRoleMeta.copy}</p></div>
        </section>

        <section className="campaign-final-cta">
          <span>YOUR TESTIMONY CHANGES EVERYTHING</span><h2>오늘 밤, 당신은<br />누구를 믿겠습니까?</h2><button type="button" onClick={() => focusJoinCard(invitedByLink ? joinMode : "solo")}>{invitedByLink ? "초대장 열기" : "혼자 사건 시작"}<ChevronRight size={19} /></button>
          <div className="campaign-record"><button type="button" onClick={() => setRankingOpen(true)}><Trophy size={15} />{leaderboard[0] ? `현재 최고 기록 ${leaderboard[0].name} · ${leaderboard[0].best_score}점` : "첫 번째 전설이 되어보세요"}</button><span>{stats.games} PLAY · {stats.wins} WIN · {stats.streak} STREAK</span></div>
        </section>

        {joinOpen && <div className="join-gate" role="dialog" aria-modal="true" aria-labelledby="join-gate-title" onMouseDown={(event) => { if (event.target === event.currentTarget) setJoinOpen(false); }}>
          <section className="join-card">
            <button className="join-gate-close" type="button" onClick={() => setJoinOpen(false)} aria-label="입장 패널 닫기"><X size={20} /></button>
            <div className="join-scanline" />
            <div className="join-card-top"><span>PRIVATE CASE TABLE</span><span className="live-dot">온라인</span></div>
            {invitedByLink && <div className="invited-room"><UserPlus size={15} /><span><b>비밀 초대장이 도착했습니다</b><small>{roomInput} 사건의 자리가 확보되어 있습니다.</small></span></div>}
            <div className="join-object-seal" aria-hidden="true"><LockKeyhole size={24} /><span>SEALED</span></div>
            <h2 id="join-gate-title">{invitedByLink ? "수사 초대에 응답" : joinMode === "first" ? "첫 사건 브리핑 시작" : joinMode === "solo" ? "혼자 수사 방 만들기" : "친구와 함께 방 만들기"}</h2>
            <p>{joinMode === "first" ? "4개의 역할과 진행관 설명으로 8~12분 안에 첫 사건을 완주합니다." : joinMode === "solo" ? "AI 용의자 7명이 자동으로 합류합니다. 이름을 입력하면 바로 첫 번째 밤이 시작됩니다." : "수사에서 사용할 이름을 정하세요. 친구에게 방 코드를 공유하면 함께 사건에 합류할 수 있습니다."}</p>
            {!invitedByLink && <div className="join-mode-picker" aria-label="플레이 방식 선택">
              <button type="button" className={joinMode === "party" ? "active" : ""} onClick={() => chooseJoinMode("party")}><Users size={17} /><span><b>친구와 함께</b><small>4–12인 · 초대 링크</small></span></button>
              <button type="button" className={joinMode === "solo" ? "active solo" : ""} onClick={() => chooseJoinMode("solo")}><Bot size={17} /><span><b>혼자 수사</b><small>AI 7명 · 즉시 시작</small></span></button>
              <button type="button" className={joinMode === "first" ? "active first" : ""} onClick={() => chooseJoinMode("first")}><BookOpen size={17} /><span><b>첫 사건</b><small>4인 · 8–12분 · 튜토리얼</small></span></button>
            </div>}
            <div className="join-steps"><span className="active"><b>01</b>이름 설정</span><i /><span><b>02</b>{joinMode === "first" ? "진행관 브리핑" : joinMode === "solo" ? "AI 합류" : "친구 합류"}</span><i /><span><b>03</b>역할 봉인</span></div>
            <div className="join-warning"><Skull size={14} /><span>아무도 믿지 마세요. 목소리도 단서가 됩니다.</span></div>
            <form onSubmit={submitJoin}>
              <label><span>당신의 이름 <em>{nick.length}/16</em></span><input id="landing-nick" value={nick} onChange={(e) => setNick(e.target.value)} placeholder="게임에서 불릴 이름" maxLength={16} /></label>
              <label><span>비밀 방 코드 <em>{invitedByLink ? "초대 링크에서 확인됨" : joinMode === "first" ? "첫 사건 전용 코드" : joinMode === "solo" ? "혼자 수사 전용 코드" : "친구와 공유할 코드"}</em></span><div className="room-field"><input value={roomInput} onChange={(e) => { setRoomInput(e.target.value); setInvitedByLink(false); }} maxLength={32} /><button type="button" onClick={() => { setRoomInput(makeRoom(joinMode)); setInvitedByLink(false); }} aria-label="새 방 코드 만들기"><RotateCcw size={15} /></button></div></label>
              <label className="terms-check"><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} /><span><b>커뮤니티 규칙과 이용약관에 동의합니다</b><small><button type="button" onClick={() => setLegalPage("terms")}>이용약관</button> · <button type="button" onClick={() => setLegalPage("community")}>커뮤니티 가이드</button> · <button type="button" onClick={() => setLegalPage("privacy")}>개인정보</button></small></span></label>
              <button className="primary-button join-enter-button" type="submit" disabled={!nick.trim() || !termsAccepted}><LogIn size={18} /><span>{!termsAccepted ? "규칙에 동의하고 입장" : joinMode === "first" ? "첫 사건 시작" : joinMode === "solo" ? "AI 용의자 7명과 즉시 시작" : nick.trim() ? `${nick.trim()}님으로 수사 합류` : "이름을 입력하고 수사 합류"}</span><ChevronRight size={16} /></button>
            </form>
            {installPrompt && <button className="install-button" type="button" onClick={installApp}><Smartphone size={16} /> 홈 화면에 앱 설치</button>}
            <div className="join-proof"><span><Check size={12} />설치 없음</span><span><Check size={12} />AI 인원 채우기</span><span><Check size={12} />실시간 음성</span></div>
             <div className="join-foot">{joinMode === "first" ? <><BookOpen size={15} /> 4인 역할 · 실제 추리형 타임라인 · 진행관 안내</> : joinMode === "solo" ? <><Bot size={15} /> AI 용의자 7명 · 혼자서도 완결되는 사건 · 초보자 브리핑 제공</> : <><Users size={15} /> 최소 4명부터 시작 · 최대 12명 · 초보자 브리핑 제공</>}</div>
          </section>
        </div>}
        {tutorialOpen && <TutorialModal step={tutorialStep} setStep={setTutorialStep} onClose={closeTutorial} />}
        {rankingOpen && <RankingModal entries={leaderboard} signedIn={Boolean(identity)} onClose={() => setRankingOpen(false)} />}
        {settingsOpen && <SettingsModal voiceOn={voiceOn} soundOn={soundOn} onVoice={toggleVoice} onSound={toggleSound} onLegal={setLegalPage} onClose={() => setSettingsOpen(false)} />}
        {legalPage && <LegalModal page={legalPage} onClose={() => setLegalPage(null)} />}
      </main>
    );
  }

  if (!game || !welcome) {
    const loadingTitle = status === "reconnecting" ? "사건 서버에 다시 연결하는 중…" : "사건 서버에 연결하는 중…";
    const loadingCopy = status === "reconnecting"
      ? "연결이 잠시 끊겼습니다. 방과 참가자 정보는 유지됩니다."
      : "첫 접속은 서버가 깨어나는 동안 최대 30초가 걸릴 수 있습니다.";
    return (
      <main className="loading-screen">
        <div className="loading-card" role="status" aria-live="polite">
          <Moon className="moon-loader" />
          <span className="loading-kicker">ROOM · {room || "UNKNOWN"}</span>
          <h1>{loadingTitle}</h1>
          <p>{loadingCopy}</p>
          <div className="loading-progress" aria-hidden="true"><i /></div>
          <button type="button" onClick={cancelJoin}><ChevronLeft size={15} /> 입장 화면으로 돌아가기</button>
        </div>
      </main>
    );
  }

  return (
    <main className={`game-shell phase-${game.phase} mobile-view-${mobileTab} ${remaining > 0 && remaining <= 10 && game.phase !== "reveal" ? "is-urgent" : ""}`}>
      <div className="grain" />
      <div className="city-atmosphere" aria-hidden="true"><i /><i /><i /></div>
      {notice && <div className="toast">{notice}</div>}
      {status !== "open" && <div className="reconnect-veil" role="status" aria-live="assertive"><div><Radio size={22} /><span><b>사건 기록 재연결 중</b><small>현재 판은 그대로 유지됩니다. 연결 표시가 돌아온 뒤 선택을 다시 전송해 주세요.</small></span></div></div>}
      {decisionFlash && <div className="decision-flash" role="status"><LockKeyhole size={18} /><span><small>COMMAND SEALED</small><b>{decisionFlash.label}</b><em>{decisionFlash.target}</em></span></div>}
      {phaseAlert && alertMeta && (
        <div className={`phase-alert phase-alert-${phaseAlert}`} role="status" aria-live="assertive">
          <div className="phase-alert-card">
            <span className="phase-alert-kicker">{alertMeta.kicker}</span>
            <div className="phase-alert-icon"><PhaseAlertIcon size={30} /></div>
            <h2>{alertMeta.title}</h2>
            <p>{alertMeta.copy}</p>
            {caseNarrative && activeChapter && <div className="phase-alert-scene"><span>{caseNarrative.codename} · {activeChapter.label}</span><b>{activeChapter.title}</b><p>{narrativeLine}</p></div>}
            {voiceOn && <div className="phase-alert-voice"><Volume2 size={13} /><span>{phaseNarration(game, phaseAlert)}</span></div>}
            {remaining > 0 && <div className="phase-alert-countdown"><b>{remaining}</b><span>초 남음</span></div>}
            <div className="phase-alert-line"><i /></div>
          </div>
        </div>
      )}
      {eventReveal && (
        <div className={`event-reveal event-${eventReveal.id}`} role="status" aria-live="assertive">
          <div>
            <span>{eventReveal.tag} · DAY {game.round}</span>
            <Sparkles size={25} />
            <h2>{eventReveal.title}</h2>
            <p>{eventReveal.copy}</p>
            <small>이번 라운드 특별 규칙</small>
            <button onClick={() => setEventReveal(null)}>확인</button>
          </div>
        </div>
      )}
      {ballotReveal && game.phase === "defense" && (
        <div className="ballot-reveal" role="dialog" aria-modal="true" aria-label="봉인 투표 공개">
          <div className="ballot-reveal-scene">
            <button className="ballot-reveal-skip" onClick={() => setBallotReveal(null)} aria-label="투표 공개 연출 건너뛰기"><X size={17} /><span>건너뛰기</span></button>
            <span>SEALED BALLOT · ROUND {game.round}</span>
            <h2>도시의 표를 공개합니다</h2>
            <div className="ballot-stamps">
              {ballotReveal.entries.slice(0, ballotReveal.visible).map((entry, index) => (
                <article key={entry.voter_id} className={index === ballotReveal.visible - 1 ? "latest" : ""}>
                  <em>{String(index + 1).padStart(2, "0")}</em><b>{entry.voter}</b><ChevronRight size={16} /><strong>{entry.target}</strong>
                </article>
              ))}
            </div>
            <small>{Math.min(ballotReveal.visible, ballotReveal.entries.length)} / {ballotReveal.entries.length} 봉인 해제</small>
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="mini-brand"><Moon size={18} fill="currentColor" /><span>검은 자정</span><button className="guide-button" onClick={() => { setTutorialStep(0); setTutorialOpen(true); }}><Film size={13} />룰 안내</button><button className="guide-button" onClick={() => setRankingOpen(true)}><Trophy size={13} />랭킹</button><button className="guide-button" onClick={() => setSettingsOpen(true)}><Settings size={13} />설정</button></div>
        <div className="room-pill"><span>ROOM</span><b>{room}</b><button onClick={copyInvite} aria-label="초대 링크 복사">{copied ? <Check size={15} /> : <Clipboard size={15} />}</button><button onClick={() => setInviteOpen(true)} aria-label="친구 초대 열기"><UserPlus size={15} /></button></div>
        <div className={`connection ${status}`}><i />{status === "open" ? `${game.players.filter((p) => p.connected).length}명 접속` : "재연결 중"}</div>
      </header>

      <section className="phase-banner">
        <div className="scene-vignette" aria-hidden="true"><i /><span /></div>
        <div className="threat-monitor"><div><Siren size={14} /><span>CITY THREAT</span><b>{cityThreat}%</b></div><div className="threat-bar"><i style={{ width: `${cityThreat}%` }} /></div><small>{aliveCount} ALIVE · {lostCount} LOST</small></div>
        <div className="phase-kicker">{game.case_mode === "first" ? "FIRST CASE · GUIDED 4-SEAT · " : game.mode === "solo" ? "SOLO CASE · " : ""}{game.case_profile.code} · {game.case_profile.location} · {game.round ? `DAY ${game.round}` : "WAITING ROOM"}</div>
        <h1>{phase[0]}</h1>
        <p><b>{game.case_profile.title}</b><span>{phase[1]}</span></p>
        <div className="phase-now" aria-live="polite"><i /><b>{PHASE_ALERT_META[game.phase].title}</b><span>{remaining > 0 ? `${remaining}초 남음` : game.phase === "lobby" ? "시작 대기 중" : "진행 중"}</span></div>
        <div className="active-directive"><Crosshair size={13} /><span><small>ACTIVE DIRECTIVE</small><b>{currentDirective}</b></span></div>
        <div className="phase-track" aria-label="게임 진행 단계">
          {PHASE_TRACK.map((stage, index) => <div key={stage} className={`${game.phase === stage ? "active" : ""} ${phaseProgressIndex > index ? "done" : ""}`}><i /><span>{PHASE_META[stage][0]}</span></div>)}
        </div>
        {game.deadline > 0 && <div className={`timer ${remaining <= 10 ? "urgent" : ""}`}><span>{String(Math.floor(remaining / 60)).padStart(2, "0")}</span>:<span>{String(remaining % 60).padStart(2, "0")}</span></div>}
      </section>

      <div className="game-grid">
        <aside className={`role-panel role-${roleMeta.color}`}>
          {game.phase === "lobby" ? <><div className="panel-label">SEALED IDENTITY</div><div className="sealed-role"><ShieldQuestion size={36} /><span>CLASSIFIED</span></div><h2>배역 봉인</h2><p>게임이 시작되는 순간 당신만의 역할이 공개됩니다.</p><div className="sealed-notice"><Skull size={14} /><span>이 방의 누군가는 마피아가 됩니다.</span></div></> : <><div className="panel-label">MY SECRET</div><div className={`role-photo avatar-photo avatar-${Math.max(0, game.players.findIndex((player) => player.id === game.me.id)) % 12}`}><span><RoleIcon size={24} /></span></div><h2>{roleMeta.name}</h2><p>{roleMeta.copy}</p><div className="role-dossier"><div><Crosshair size={13} /><span><small>WIN CONDITION</small><b>{roleMeta.goal}</b></span></div><div><Activity size={13} /><span><small>FIELD ABILITY</small><b>{roleMeta.power}</b></span></div><p>{roleMeta.cover}</p></div>{role === "mafia" && <div className="secret-box"><b>마피아 동료</b><span>{game.players.filter((p) => p.mafia && p.id !== game.me.id).map((p) => p.n).join(", ") || "당신 혼자입니다"}</span></div>}{game.me.intel.length > 0 && <div className="secret-box intel"><b>조사 기록</b>{game.me.intel.map((line) => <span key={line}>{line}</span>)}</div>}{game.me.mission && <div className="secret-box mission"><b>이번 판 비밀 미션</b><span>{game.me.mission}</span><em className={game.me.mission_completed ? "completed" : ""}>{game.me.mission_completed ? "MISSION COMPLETE · +10" : "진행 중"}</em></div>}<div className="evidence-board"><div><Search size={14} /><b>나만의 추리 보드</b></div>{game.players.filter((player) => player.id !== game.me.id).slice(0, 8).map((player) => <div className="evidence-row" key={player.id}><span>{player.n}</span><button className={evidence[player.id] === 1 ? "safe active" : "safe"} onClick={() => setEvidence((current) => ({ ...current, [player.id]: current[player.id] === 1 ? 0 : 1 }))}>안전</button><button className={evidence[player.id] === -1 ? "suspect active" : "suspect"} onClick={() => setEvidence((current) => ({ ...current, [player.id]: current[player.id] === -1 ? 0 : -1 }))}>의심</button></div>)}</div>{!game.me.alive && role !== "spectator" && <div className="dead-stamp">사망</div>}</>}
          </aside>

        <section className="table-panel">
          <div className="panel-heading"><div><span>{game.phase === "lobby" ? "SUSPECT FILES" : "THE TABLE"}</span><h2>{game.phase === "lobby" ? "용의자 명단" : "참가자"}</h2></div><div>{game.players.filter((p) => p.alive).length} 생존</div></div>
          {caseNarrative && activeChapter && <NarrativeSceneCard game={game} narrative={caseNarrative} chapter={activeChapter} narrativeLine={narrativeLine} />}
          {game.phase === "lobby" && game.lobby_mode === "first" && humanCount === 1 && game.host === game.me.id && <section className="solo-mode-card first-case-card"><div className="solo-mode-icon"><BookOpen size={22} /></div><div><small>FIRST CASE · GUIDED 4-SEAT</small><b>첫 사건: 8~12분 추리 튜토리얼</b><p>마피아·의사·탐정·시민만 등장합니다. 진행관이 매 단계 설명하고, 단서 순서를 실제 행동과 연결합니다.</p></div><button type="button" onClick={() => send({ t: "first_start" })}><Sparkles size={15} />첫 사건 시작</button></section>}
          {game.phase === "lobby" && game.lobby_mode === "solo" && humanCount === 1 && game.host === game.me.id && <section className="solo-mode-card"><div className="solo-mode-icon"><Bot size={22} /></div><div><small>SOLO CASE MODE · AI CAST</small><b>혼자서도 한 편의 사건을 시작하세요</b><p>이 방은 혼자 수사 전용입니다. 7명의 AI 용의자가 자동으로 합류한 뒤 사건이 시작됩니다.</p></div><button type="button" onClick={() => send({ t: "solo_start" })}><Sparkles size={15} />혼자 사건 시작</button></section>}
          {game.round_event && game.phase !== "lobby" && (
            <section className={`round-event-card event-${game.round_event.id}`}>
              <div><Sparkles size={17} /><span><small>{game.round_event.tag} · DAY {game.round}</small><b>{game.round_event.title}</b></span></div>
              <p>{game.round_event.copy}</p>
              <footer><span>{game.pressure_progress.sealed && game.phase === "day" ? "긴급 지목 봉인 중" : "긴급 지목 현황"}</span><b>{game.pressure_progress.completed}/{game.pressure_progress.total}</b></footer>
            </section>
          )}
          {game.me.private_lead && game.phase !== "lobby" && <PrivateLeadCard lead={game.me.private_lead} canReveal={game.phase === "day" && game.me.alive} onReveal={() => send({ t: "reveal_lead", lead_id: game.me.private_lead?.id })} />}
          {game.phase === "reveal" && <MemorySealCard game={game} text={memoryText} setText={setMemoryText} onSubmit={submitMemory} />}
          {["dawn", "day", "vote"].includes(game.phase) && <SceneReconstructionCard game={game} order={sceneOrder} setOrder={setSceneOrder} onSubmit={submitScene} />}
          {["day", "vote", "gameover"].includes(game.phase) && <EvidenceChainCard game={game} target={theoryTarget} setTarget={setTheoryTarget} clueId={theoryClueId} setClueId={setTheoryClueId} fragmentId={theoryFragmentId} setFragmentId={setTheoryFragmentId} stake={theoryStake} setStake={setTheoryStake} onSubmit={submitTheory} />}
          {game.phase === "day" && <OathCard game={game} target={oathTarget} setTarget={setOathTarget} text={oathText} setText={setOathText} onSubmit={submitOath} />}
          {game.phase === "day" && <ContractCard game={game} target={contractTarget} setTarget={setContractTarget} text={contractText} setText={setContractText} onSubmit={submitContract} onResponse={(contractId, accepted) => send({ t: "contract_response", contract_id: contractId, accepted })} />}
          {!game.me.alive && !["spectator", "mafia"].includes(role) && <AfterlifePanel game={game} onPredict={(target) => send({ t: "ghost_predict", target })} ghostText={ghostText} setGhostText={setGhostText} onEcho={submitGhostEcho} />}
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
          {game.phase === "day" && (
            <section className="anonymous-tip-panel" aria-label="익명 제보실">
              <header>
                <div><Radio size={16} /><span><b>익명 제보실</b><small>AUTHOR SEALED · 이번 낮 1회</small></span></div>
                <em>{game.tips.filter((tip) => tip.round === game.round).length}건 봉인</em>
              </header>
              <p>출처는 공개되지 않습니다. 사실일 수도, 마피아가 흘린 함정일 수도 있습니다.</p>
              <div className="anonymous-tip-feed">
                {game.tips.filter((tip) => tip.round === game.round).length === 0
                  ? <span>아직 도착한 익명 제보가 없습니다.</span>
                  : game.tips.filter((tip) => tip.round === game.round).map((tip, index) => <article key={tip.id}><i>{String(index + 1).padStart(2, "0")}</i><b>익명 제보</b><span>{tip.text}</span></article>)}
              </div>
              {game.me.alive ? <form onSubmit={submitTip}><input value={tipText} onChange={(event) => setTipText(event.target.value)} maxLength={120} placeholder="사건 기록과 어긋나는 한 가지를 제보하세요" /><button disabled={!tipText.trim() || !game.me.can_tip}><LockKeyhole size={14} />{game.me.can_tip ? "제보 봉인" : "이미 봉인"}</button></form> : <small className="anonymous-tip-dead">사망자는 제보를 남길 수 없지만 도착한 내용을 열람할 수 있습니다.</small>}
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
          {game.phase === "gameover" && game.awards.length > 0 && (
            <section className="case-awards"><header><Award size={18} /><span><b>자정의 사건 훈장</b><small>이번 판에서 만들어진 플레이 스타일 기록</small></span></header><div>{game.awards.map((award) => <article key={award.id}><Award size={20} /><span><small>{award.title}</small><b>{award.player}</b><p>{award.copy}</p></span></article>)}</div></section>
          )}
          {game.phase === "gameover" && <CaseReportPanel game={game} />}
          <div className="reaction-layer" aria-live="polite">{game.reactions.map((reaction, index) => <div key={reaction.id} style={{ left: `${12 + (index * 17) % 74}%`, animationDelay: `${(index % 3) * .08}s` }}><b>{reaction.emoji}</b><span>{reaction.from}</span></div>)}</div>
          <div className="player-grid">
            {game.players.map((player, index) => {
              const clueHeat = game.clues.filter((clue) => clue.suspect_ids.includes(player.id)).length * 24;
              const leadHeat = game.public_leads.filter((lead) => lead.suspect_id === player.id).length * 18;
              const readHeat = (game.read_summary[player.id]?.suspect ?? 0) * 12;
              const pressureCount = game.pressure_counts[player.id] ?? 0;
              const suspicion = Math.min(100, clueHeat + leadHeat + readHeat + pressureCount * 16 + player.votes * 14);
              return <PlayerCard key={player.id} player={player} index={index} self={player.id === game.me.id} host={player.id === game.host} accused={player.id === game.accused_id} selected={selected === player.id} selectable={targetPlayers.some((p) => p.id === player.id)} speaking={player.id === game.speaker_id} suspicion={suspicion} pressureCount={pressureCount} pressureMarkedByMe={game.me.pressure_target === player.id} canPressure={game.phase === "day" && game.me.alive && player.alive && player.id !== game.me.id && !game.me.pressure_target} mark={evidence[player.id] ?? 0} phase={game.phase} onSelect={() => setSelected(player.id)} onPressure={() => send({ t: "pressure", target: player.id })} />;
            })}
            {game.phase === "lobby" && Array.from({ length: Math.max(0, game.min_players - game.players.length) }).map((_, i) => <div className="empty-seat" key={i}><span>+</span><p>빈자리</p></div>)}
          </div>
          {game.phase === "lobby" && game.host === game.me.id && game.players.some((player) => player.id !== game.me.id) && <div className="host-roster-tools"><span>HOST CONTROL</span>{game.players.filter((player) => player.id !== game.me.id).map((player) => <button key={player.id} onClick={() => send({ t: "remove_seat", target: player.id })} aria-label={`${player.n} 대기실에서 내보내기`}><X size={11} />{player.n}</button>)}</div>}

          {selectedPlayer && ["night", "vote"].includes(game.phase) && <div className={`target-lock ${game.phase === "vote" ? "vote-lock" : ""}`}><div className={`target-lock-photo avatar-photo avatar-${Math.max(0, selectedPlayerIndex) % 12}`} /><Crosshair size={18} /><span><small>{game.phase === "vote" ? "EXECUTION CANDIDATE" : "TARGET LOCKED"}</small><b>{selectedPlayer.n}</b><em>{game.phase === "vote" ? "최종 투표 대상" : refinedActionCopy}</em></span><button onClick={() => setSelected(null)} aria-label="선택 대상 해제"><X size={15} /></button></div>}
          <div className="action-bar">
            {game.phase === "lobby" && (
              <>
                <div><b>{game.players.length}/{game.max_players}명 등록 · 사람 준비 {readyHumans}/{humanCount} · {game.pace === "quick" ? "퀵 약 25분" : "클래식 35분+"}</b><span>{unreadyPlayers.length ? `${unreadyPlayers.map((player) => player.n).slice(0, 3).join(", ")}님의 준비를 기다리는 중입니다.` : "역할 배정 준비가 끝났습니다."}</span></div>
                {game.host === game.me.id && <div className="pace-switch"><button className={game.pace === "quick" ? "active" : ""} onClick={() => send({ t: "pace", pace: "quick" })}><TimerReset size={14} />퀵 · 약 25분</button><button className={game.pace === "classic" ? "active" : ""} onClick={() => send({ t: "pace", pace: "classic" })}>클래식 · 35분+</button></div>}
                {game.host === game.me.id && <div className="bot-fill-switch"><Bot size={14} /><span>AI 인원</span>{[4, 6, 8].map((target) => <button key={target} className={game.players.length === target ? "active" : ""} onClick={() => send({ t: "fill_bots", target })}>{target}</button>)}</div>}
                <button className="secondary-button" onClick={() => setInviteOpen(true)}><UserPlus size={17} />친구 초대</button>
                {game.host !== game.me.id && <button className="secondary-button" onClick={() => send({ t: "ready" })}>{me?.ready ? <Check size={17} /> : <ShieldQuestion size={17} />}{me?.ready ? "준비 취소" : "준비하기"}</button>}
                {game.host === game.me.id && game.lobby_mode === "first" && humanCount === 1 && <button className="secondary-button solo-start-button" onClick={() => send({ t: "first_start" })}><BookOpen size={17} />첫 사건 시작</button>}
                {game.host === game.me.id && game.lobby_mode === "solo" && humanCount === 1 && <button className="secondary-button solo-start-button" onClick={() => send({ t: "solo_start" })}><Bot size={17} />혼자 사건 시작</button>}
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
            {game.phase === "gameover" && <><div><b>{game.winner === "mafia" ? "마피아 팀 승리" : game.winner === "trickster" ? "광대 단독 승리" : "시민 팀 승리"}</b><span>{getEndingLine(game)}</span></div><button className="secondary-button" onClick={() => setCaseOpen(true)}><BookOpen size={17} />전체 기록</button><button className="secondary-button" onClick={() => createPoster("result")}><Share2 size={17} />사건 리포트</button>{game.host === game.me.id && <button className="primary-button compact" onClick={() => send({ t: "rematch" })}><RotateCcw size={17} />다시 하기</button>}</>}
          </div>
        </section>

        <aside className="comms-panel">
          <div className="story-card">
            <div className="story-card-head"><div className="panel-label">CASE INVESTIGATION</div><button onClick={() => setCaseOpen(true)}><BookOpen size={13} />전체 기록</button></div>
            {caseNarrative && activeChapter && <NarrativeRail game={game} narrative={caseNarrative} chapter={activeChapter} />}
            <div className="ai-director"><div><Radio size={14} /><b>현장 지휘실 · 다음 수사</b><i /></div><p>{game.guide}</p></div>
             {game.director_beats.length > 0 && <DirectorBeatCard beats={game.director_beats} />}
             {(game.mode === "solo" || game.case_mode === "first") && game.ai_social && <AISocialPanel entries={game.ai_social} />}
            <div className="forensic-board">
              <header><Search size={14} /><span><b>현장 감식 단서</b><small>{game.clues.length ? `${game.clues.length}개 확보 · 범인을 포함한 후보군` : "첫 번째 사건 보고를 기다리는 중"}</small></span></header>
              {game.clues.length ? <div>{game.clues.slice(-3).reverse().map((clue) => <article key={clue.id}><span>{clue.code}</span><b>{clue.title}</b><p>{clue.detail}</p><small>{clue.outcome} · DAY {clue.round}</small></article>)}</div> : <p className="forensic-empty">밤의 습격이 발생하면 감식반이 범인을 포함한 용의자 묶음을 공개합니다.</p>}
            </div>
            {game.public_leads.length > 0 && <div className="public-leads"><header><LockKeyhole size={14} /><span><b>플레이어 공개 증거</b><small>진짜와 위조 증거는 같은 인장을 사용합니다</small></span></header>{game.public_leads.slice(-4).reverse().map((lead) => <article key={lead.id}><span>{lead.owner} 공개</span><b>{lead.title}</b><p>{lead.detail}</p></article>)}</div>}
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
      <div className={`mobile-command-dock command-${game.phase}`}>
        <span><small>{game.phase === "night" ? "NIGHT ORDER" : game.phase === "vote" ? "SEALED BALLOT" : game.phase === "verdict" ? "FINAL VERDICT" : "CURRENT OBJECTIVE"}</small><b>{remaining > 0 ? `${remaining}초 · ` : ""}{currentDirective}</b></span>
        {game.phase === "lobby" && game.host === game.me.id && game.lobby_mode === "first" && humanCount === 1 ? <button className="primary solo-dock-button" onClick={() => send({ t: "first_start" })}><BookOpen size={15} />첫 사건 시작</button> : game.phase === "lobby" && game.host === game.me.id && game.lobby_mode === "solo" && humanCount === 1 ? <button className="primary solo-dock-button" onClick={() => send({ t: "solo_start" })}><Bot size={15} />혼자 사건 시작</button> : game.phase === "lobby" && game.host === game.me.id && <button className="primary" disabled={game.players.length >= game.min_players && unreadyPlayers.length > 0} onClick={() => game.players.length < game.min_players ? send({ t: "fill_bots", target: game.min_players }) : send({ t: "start" })}>{game.players.length < game.min_players ? `AI ${game.min_players}명 채우기` : unreadyPlayers.length ? "준비 대기" : "게임 시작"}</button>}
        {game.phase === "lobby" && game.host !== game.me.id && <button className={me?.ready ? "" : "primary"} onClick={() => send({ t: "ready" })}>{me?.ready ? "준비 취소" : "준비하기"}</button>}
        {game.phase === "night" && game.me.alive && ["mafia", "doctor", "detective", "bodyguard"].includes(role) && <button className="primary" onClick={() => selected ? commitDecision("action") : setMobileTab("suspects")}>{selected ? "명령 봉인" : "대상 선택"}</button>}
        {game.phase === "vote" && game.me.alive && <button className="danger" onClick={() => selected ? commitDecision("vote") : setMobileTab("suspects")}>{selected ? "표 봉인" : "용의자 선택"}</button>}
        {game.phase === "day" && <button onClick={() => setMobileTab("talk")}>{isCurrentSpeaker ? "내 진술 열기" : "토론 참여"}</button>}
        {game.phase === "defense" && <button onClick={() => setMobileTab("talk")}>{isAccused ? "최후 변론" : "변론 듣기"}</button>}
        {game.phase === "verdict" && game.me.alive && !isAccused && <div><button onClick={() => commitJudgement(false)}>석방</button><button className="danger" onClick={() => commitJudgement(true)}>처형</button></div>}
      </div>
      <nav className="mobile-game-nav" aria-label="모바일 게임 메뉴">
        <button className={mobileTab === "case" ? "active" : ""} onClick={() => { if (mobileTab === "talk") setSeenChatCount(game.chat.length); setMobileTab("case"); }}><BookOpen size={19} /><span>사건</span>{game.clues.length > 0 && <i>{game.clues.length}</i>}</button>
        <button className={mobileTab === "suspects" ? "active" : ""} onClick={() => { if (mobileTab === "talk") setSeenChatCount(game.chat.length); setMobileTab("suspects"); }}><Search size={19} /><span>수사</span></button>
        <button className={mobileTab === "talk" ? "active" : ""} onClick={() => { setMobileTab("talk"); setSeenChatCount(game.chat.length); }}><MessageCircle size={19} /><span>대화</span>{unreadChatCount > 0 && <i>{Math.min(9, unreadChatCount)}</i>}</button>
        <button className={mobileTab === "role" ? "active" : ""} onClick={() => { if (mobileTab === "talk") setSeenChatCount(game.chat.length); setMobileTab("role"); }}><ShieldQuestion size={19} /><span>{!game.me.alive && role !== "mafia" ? "사후 수사" : "내 정보"}</span></button>
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

function NarrativeSceneCard({ game, narrative, chapter, narrativeLine }: { game: GameState; narrative: CaseNarrative; chapter: CaseNarrative["chapters"][number]; narrativeLine: string }) {
  const chapterIndex = narrative.chapters.findIndex((item) => item.id === chapter.id);
  return (
    <section className={`narrative-scene-card narrative-scene-${chapter.id}`} aria-label="현재 사건 장면">
      <div className="narrative-scene-top"><span>{game.mode === "solo" ? "SOLO CASE · " : ""}{chapter.label}</span><small>{narrative.codename} · {String(chapterIndex + 1).padStart(2, "0")} / {String(narrative.chapters.length).padStart(2, "0")}</small></div>
      <div className="narrative-scene-copy"><b>{game.phase === "gameover" ? "사건의 마지막 문장" : chapter.title}</b><p>{game.phase === "gameover" ? getEndingLine(game) : narrativeLine}</p></div>
      <div className="narrative-scene-steps" aria-label="사건 챕터 진행">
        {narrative.chapters.map((item, index) => <i key={item.id} className={index < chapterIndex ? "done" : index === chapterIndex ? "active" : ""} title={item.label} />)}
      </div>
    </section>
  );
}

function NarrativeRail({ game, narrative, chapter }: { game: GameState; narrative: CaseNarrative; chapter: CaseNarrative["chapters"][number] }) {
  const chapterIndex = narrative.chapters.findIndex((item) => item.id === chapter.id);
  return (
    <section className="narrative-rail" aria-label="사건 서사 진행">
      <header><div><span>CASE NARRATIVE</span><b>{narrative.codename}</b></div><small>CHAPTER {chapterIndex + 1} / {narrative.chapters.length}</small></header>
      <p className="narrative-motif">“{game.phase === "lobby" ? narrative.prologue : narrative.motif}”</p>
      <div className="narrative-rail-steps">{narrative.chapters.map((item, index) => <div key={item.id} className={index < chapterIndex ? "done" : index === chapterIndex ? "active" : ""}><i /><span>{item.label.replace(/^CHAPTER \d+ · /, "")}</span></div>)}</div>
    </section>
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
  const narrative = getCaseNarrative(game.case_profile.id);
  return (
    <div className="case-backdrop" role="dialog" aria-modal="true" aria-label="전체 사건 기록">
      <section className="case-modal">
        <header><div><span>BLACK MIDNIGHT / ARCHIVE · {narrative.codename}</span><h2>사건 파일</h2><p>ROOM {room} · DAY {game.round || 0} · {game.case_profile.location}</p></div><button onClick={onClose} aria-label="사건 기록 닫기"><X size={19} /></button></header>
        <div className="case-modal-grid">
          <aside><div className="case-seal"><Gavel size={26} /><span>{game.phase === "gameover" ? "CASE CLOSED" : "ACTIVE CASE"}</span></div><div className="case-prologue"><small>PROLOGUE · {game.case_profile.victim}</small><b>{game.case_profile.title}</b><p>{narrative.prologue}</p><em>{narrative.motif}</em></div><h3>용의자 기록</h3>{game.players.map((player, index) => <div className="case-suspect" key={player.id}><div className={`avatar-photo avatar-${index % 12}`} /><span><b>{player.n}</b><small>{game.phase === "gameover" && player.role ? ROLE_META[player.role].name : player.alive ? "생존 · 신원 미상" : "사망 · 신원 미상"}</small></span><em>{player.score} PTS</em></div>)}</aside>
          <article><div className="case-log-title"><span>FORENSIC EVIDENCE</span><b>{game.clues.length} CLUES</b></div>{game.clues.length > 0 && <div className="case-clue-grid">{game.clues.map((clue) => <div key={clue.id}><span>{clue.code}</span><b>{clue.title}</b><p>{clue.detail}</p><small>{clue.outcome}</small></div>)}</div>}{game.theory_board.length > 0 && <><div className="case-log-title theory-file-title"><span>CHAIN OF EVIDENCE</span><b>{game.theory_board.length} HYPOTHESES</b></div><div className="case-theory-grid">{[...game.theory_board].reverse().map((theory) => <div key={theory.id}><header><b>{theory.owner} → {theory.target}</b><em>{theory.status ? `${theory.matched_links ?? 0}/${theory.total_links ?? 3}` : "SEALED"}</em></header><p>{theory.clue_code} · {theory.clue_title}</p><p>{theory.fragment_time} · {theory.fragment_title}</p>{theory.explanation && <small>{theory.explanation}</small>}</div>)}</div></>}<div className="case-log-title timeline-title"><span>INCIDENT TIMELINE</span><b>{game.case_log.length} RECORDS</b></div><div className="case-log-scroll">{game.case_log.length === 0 && <p className="case-empty">아직 기록된 사건이 없습니다.</p>}{game.case_log.map((line, index) => <div key={`${line}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><p>{line}</p></div>)}</div><button className="secondary-button case-copy" onClick={onCopy}><Clipboard size={16} />전체 사건 기록 복사</button></article>
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

function PrivateLeadCard({ lead, canReveal, onReveal }: { lead: NonNullable<GameState["me"]["private_lead"]>; canReveal: boolean; onReveal: () => void }) {
  return <section className={`sealed-lead-card ${lead.revealed ? "revealed" : ""}`}><div className="lead-seal"><LockKeyhole size={18} /></div><span><small>PRIVATE EVIDENCE · 1회 공개</small><b>{lead.title}</b><p>{lead.detail}</p></span>{lead.revealed ? <em><Check size={13} />공개됨</em> : <button disabled={!canReveal} onClick={onReveal}>{canReveal ? "공식 증거로 공개" : "첫 낮에 공개 가능"}</button>}</section>;
}

function MemorySealCard({ game, text, setText, onSubmit }: { game: GameState; text: string; setText: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  return <section className="memory-seal-card"><header><LockKeyhole size={17} /><span><small>MEMORY SEAL · ROUND {game.round}</small><b>첫 기억을 봉인하세요</b></span><em>{game.memory_reveals.length}개 공개</em></header><p>{game.me.memory_prompt}</p>{game.me.memory_seal ? <div className="memory-sealed-copy"><Check size={14} />{game.me.memory_seal.text}</div> : <form onSubmit={onSubmit}><input value={text} onChange={(event) => setText(event.target.value)} maxLength={160} placeholder="나중에 확인할 첫 인상을 기록하세요" /><button disabled={!game.me.can_seal_memory || text.trim().length < 5}><LockKeyhole size={14} />기억 봉인</button></form>}{game.memory_reveals.length > 0 && <div className="memory-reveal-list">{game.memory_reveals.map((seal) => <article key={seal.id}><small>{seal.owner} · DAY {seal.round}</small><span>{seal.text}</span></article>)}</div>}</section>;
}

function SceneReconstructionCard({ game, order, setOrder, onSubmit }: { game: GameState; order: string[]; setOrder: (value: string[]) => void; onSubmit: () => void }) {
  const toggle = (id: string) => setOrder(order.includes(id) ? order.filter((item) => item !== id) : [...order, id]);
  return <section className="scene-reconstruction-card"><header><Search size={17} /><span><small>CAUSAL TIMELINE · ROUND {game.round}</small><b>현장 타임라인 복원</b></span><em>{game.scene_progress.completed}/{game.scene_progress.total} 제출</em></header><p>시계 기록이 항상 진실은 아닙니다. 접근·기록 공백·습격·알리바이·봉인의 인과를 비교해 실제 행동이 이어지는 순서를 찾아보세요.</p><div className="scene-fragment-grid">{game.me.scene_fragments.map((fragment) => <button type="button" key={fragment.id} className={order.includes(fragment.id) ? "picked" : ""} onClick={() => toggle(fragment.id)}><small>{fragment.time}</small><b>{fragment.title}</b><span>{fragment.detail}</span>{order.includes(fragment.id) && <i>{order.indexOf(fragment.id) + 1}</i>}</button>)}</div><footer>{game.me.scene_result ? <span className="scene-result"><Check size={14} />내 재구성 {game.me.scene_result.score}점 · {game.me.scene_result.correct_pairs}/{game.me.scene_result.total} 시간 연결{game.me.scene_result.deduction && <small>{game.me.scene_result.deduction}</small>}</span> : <><span>{order.length}개 조각 선택</span><button type="button" disabled={!game.me.can_reconstruct || order.length < 2} onClick={onSubmit}><LockKeyhole size={14} />타임라인 제출</button></>}</footer></section>;
}

function EvidenceChainCard({ game, target, setTarget, clueId, setClueId, fragmentId, setFragmentId, stake, setStake, onSubmit }: {
  game: GameState;
  target: string | null;
  setTarget: (value: string | null) => void;
  clueId: string | null;
  setClueId: (value: string | null) => void;
  fragmentId: string | null;
  setFragmentId: (value: string | null) => void;
  stake: 1 | 2;
  setStake: (value: 1 | 2) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const candidates = game.players.filter((player) => player.alive && player.id !== game.me.id && player.role !== "spectator");
  // A clue is allowed to be a deliberate red herring. The server only
  // reveals whether the suspect–clue link was real after the case closes.
  const clues = game.clues;
  const sealed = game.me.theory && game.me.theory.round === game.round;
  const board = [...game.theory_board].reverse();
  const statusLabel: Record<NonNullable<GameState["theory_board"][number]["status"]>, string> = {
    confirmed: "완전 적중",
    partial: "부분 적중",
    broken: "연결 붕괴",
  };
  return (
    <section className="evidence-chain-card" aria-label="증거 연결 고리">
      <header>
        <Link2 size={17} />
        <span><small>CHAIN OF EVIDENCE · ROUND {game.round}</small><b>증거 연결 고리</b></span>
        <em>{game.me.theory_stakes} 인장 남음</em>
      </header>
      <p>용의자 하나, 공개 감식 단서 하나, 내가 가진 시간 조각 하나를 연결하세요. 1~2개의 증거 인장을 걸고, 단서가 미끼였는지는 사건 종료 때만 공개됩니다.</p>
      <div className="evidence-chain-note"><Sparkles size={13} />단서가 용의자를 직접 가리키지 않아도 선택할 수 있습니다. 세 연결을 모두 확신할 때만 인장 2개를 거세요.</div>
      {game.phase === "day" && game.me.can_theorize && !sealed && (
        <form className="evidence-chain-form" onSubmit={onSubmit}>
          <label><span>용의자</span><select value={target ?? ""} onChange={(event) => { setTarget(event.target.value || null); setClueId(null); }}><option value="">연결할 용의자 선택</option>{candidates.map((player) => <option key={player.id} value={player.id}>{player.n}</option>)}</select></label>
          <label><span>공개 단서</span><select value={clueId ?? ""} onChange={(event) => setClueId(event.target.value || null)} disabled={!target || clues.length === 0}><option value="">{!target ? "먼저 용의자를 선택" : clues.length ? "사건 파일의 단서 선택" : "아직 감식 단서 없음"}</option>{clues.map((clue) => <option key={clue.id} value={clue.id}>{clue.code} · {clue.title}</option>)}</select></label>
          <label><span>내 시간 조각</span><select value={fragmentId ?? ""} onChange={(event) => setFragmentId(event.target.value || null)}><option value="">내 기록 조각 선택</option>{game.me.scene_fragments.map((fragment) => <option key={fragment.id} value={fragment.id}>{fragment.time} · {fragment.title}</option>)}</select></label>
          <label className="evidence-stake"><span>걸 인장</span><select value={stake} onChange={(event) => setStake(Number(event.target.value) === 2 ? 2 : 1)}><option value={1}>1개 · 안전한 추리</option><option value={2} disabled={game.me.theory_stakes < 2}>2개 · 확신을 건다</option></select></label>
          <button type="submit" disabled={!target || !clueId || !fragmentId}><LockKeyhole size={14} />가설 봉인</button>
        </form>
      )}
      {game.phase === "day" && !game.me.can_theorize && !sealed && <div className="evidence-chain-locked"><LockKeyhole size={14} />이번 판의 인장을 모두 사용했거나 아직 연결할 감식 단서가 없습니다.</div>}
      {sealed && <div className="evidence-chain-locked"><Check size={14} />이번 낮의 가설을 봉인했습니다. 다른 용의자들의 연결을 비교해 보세요.</div>}
      {game.phase === "vote" && <div className="evidence-chain-locked"><Vote size={14} />투표 전 봉인된 가설입니다. 누구의 인과 고리가 가장 구체적인지 확인하세요.</div>}
      {game.phase === "gameover" && <div className="evidence-chain-locked resolved"><Sparkles size={14} />사건 파일이 닫혔습니다. 봉인된 연결의 진위가 공개됩니다.</div>}
      <div className="evidence-chain-board">
        {board.length === 0 ? <span className="evidence-chain-empty">아직 봉인된 증거 연결이 없습니다. 첫 번째 가설을 남겨 보세요.</span> : board.map((theory) => (
          <article key={theory.id} className={`evidence-chain-row ${theory.status ?? "sealed"}`}>
            <div className="evidence-chain-row-head"><span>DAY {theory.round} · {theory.owner} → {theory.target}</span><em>인장 {theory.stake}</em></div>
            <div className="evidence-chain-links"><b>{theory.clue_code} · {theory.clue_title}</b><Link2 size={13} /><b>{theory.fragment_time} · {theory.fragment_title}</b></div>
            {theory.status && <p><strong>{statusLabel[theory.status]} · {theory.matched_links}/{theory.total_links} 연결</strong>{theory.explanation}</p>}
          </article>
        ))}
      </div>
    </section>
  );
}

function OathCard({ game, target, setTarget, text, setText, onSubmit }: { game: GameState; target: string | null; setTarget: (value: string | null) => void; text: string; setText: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  const candidates = game.players.filter((player) => player.alive && player.id !== game.me.id && player.role !== "spectator");
  return <section className="oath-card"><header><ShieldCheck size={17} /><span><small>PUBLIC OATH · ROUND {game.round}</small><b>말을 맹세로 바꾸기</b></span><em>{game.oaths.length}개 봉인</em></header><p>투표 전에 누구를 지목할지 공개적으로 약속하세요. 실제 표와 비교되어 다음 판 점수에 반영됩니다.</p>{game.oaths.length > 0 && <div className="oath-feed">{game.oaths.slice(-3).map((oath) => <article key={oath.id}><b>{oath.owner}</b><span>→ {oath.target}</span><p>{oath.text}</p>{oath.kept !== null && <small>{oath.kept ? "약속을 지킴" : "약속을 어김"}</small>}</article>)}</div>}{game.me.can_oath ? <form onSubmit={onSubmit}><select value={target ?? ""} onChange={(event) => setTarget(event.target.value || null)}><option value="">지목할 용의자 선택</option>{candidates.map((player) => <option key={player.id} value={player.id}>{player.n}</option>)}</select><input value={text} onChange={(event) => setText(event.target.value)} maxLength={100} placeholder="예: 다음 투표에서 이 사람의 알리바이를 확인하겠습니다" /><button disabled={!target}><LockKeyhole size={14} />맹세 봉인</button></form> : <small className="oath-locked">이번 낮의 맹세는 이미 봉인되었거나 참여할 수 없습니다.</small>}</section>;
}

function ContractCard({ game, target, setTarget, text, setText, onSubmit, onResponse }: { game: GameState; target: string | null; setTarget: (value: string | null) => void; text: string; setText: (value: string) => void; onSubmit: (event: FormEvent) => void; onResponse: (contractId: string, accepted: boolean) => void }) {
  const candidates = game.players.filter((player) => player.alive && player.id !== game.me.id && player.role !== "spectator");
  const mine = game.contracts?.find((contract) => contract.owner_id === game.me.id && contract.round === game.round);
  const incoming = game.contracts?.find((contract) => contract.target_id === game.me.id && contract.round === game.round && contract.accepted === null);
  return <section className="contract-card"><header><LockKeyhole size={17} /><span><small>SECRET CONTRACT · ROUND {game.round}</small><b>둘만 아는 약속</b></span><em>{game.contracts?.filter((contract) => contract.round === game.round).length ?? 0}개</em></header><p>상대에게만 보이는 한 줄 계약입니다. 지켜지면 신뢰가 쌓이고, 배신은 AI와 다음 판 관계에 남습니다.</p>{incoming && <div className="contract-incoming"><b>{incoming.owner}님의 제안</b><span>{incoming.text}</span><div><button type="button" onClick={() => onResponse(incoming.id, true)}><Check size={13} />수락</button><button type="button" onClick={() => onResponse(incoming.id, false)}>거절</button></div></div>}{mine ? <div className="contract-sealed"><Check size={14} />{mine.target}님에게 계약이 전달되었습니다. 응답: {mine.accepted === null ? "대기 중" : mine.accepted ? "수락" : "거절"}</div> : !incoming && <form onSubmit={onSubmit}><select value={target ?? ""} onChange={(event) => setTarget(event.target.value || null)}><option value="">계약 상대 선택</option>{candidates.map((player) => <option key={player.id} value={player.id}>{player.n}</option>)}</select><input value={text} onChange={(event) => setText(event.target.value)} maxLength={100} placeholder="예: 이번 밤 서로를 지키고 아침에 기록을 비교하자" /><button disabled={!target || text.trim().length < 5}><LockKeyhole size={14} />계약 봉인</button></form>}</section>;
}

function AISocialPanel({ entries }: { entries: NonNullable<GameState["ai_social"]> }) {
  return <section className="ai-social-panel"><header><Bot size={16} /><span><b>AI 용의자 관계 기록</b><small>이전 발언과 감정이 다음 판단에 반영됩니다.</small></span></header><div>{entries.slice(0, 4).map((entry) => <article key={entry.player_id}><div className={`ai-emotion emotion-${entry.emotion}`}><i /></div><span><b>{entry.player}</b><small>{entry.persona} · 신뢰 {entry.trust > 0 ? "+" : ""}{entry.trust}</small><p>{entry.memory}</p></span></article>)}</div></section>;
}

function CaseReportPanel({ game }: { game: GameState }) {
  const grade = game.case_grade || "B";
  return <section className="case-report-panel"><header><Trophy size={18} /><span><b>CASE REPORT · {grade} GRADE</b><small>이번 판의 추리 연결과 사회적 흔적</small></span><strong>{grade}</strong></header>{game.best_persuader && <div className="report-persuader"><MessageCircle size={15} /><span><small>가장 설득력 있었던 사람</small><b>{game.best_persuader.player}</b><p>{game.best_persuader.copy}</p></span></div>}<div className="report-badges">{(game.case_badges ?? []).map((badge) => <article key={badge.id}><Award size={14} /><span><b>{badge.title}</b><small>{badge.copy}</small></span></article>)}</div><div className="report-highlights">{(game.final_highlights ?? []).map((highlight) => <p key={`${highlight.kind}-${highlight.title}`}><b>{highlight.title}</b><span>{highlight.copy}</span></p>)}</div></section>;
}

function DirectorBeatCard({ beats }: { beats: GameState["director_beats"] }) {
  const beat = beats.at(-1);
  if (!beat) return null;
  return <div className={`director-beat-card tone-${beat.tone}`}><div><Radio size={13} /><span><small>DIRECTOR BEAT · DAY {beat.round}</small><b>{beat.title}</b></span></div><p>{beat.copy}</p></div>;
}

function AfterlifePanel({ game, onPredict, ghostText, setGhostText, onEcho }: { game: GameState; onPredict: (target: string) => void; ghostText: string; setGhostText: (value: string) => void; onEcho: (event: FormEvent) => void }) {
  const prediction = game.players.find((player) => player.id === game.me.ghost_prediction);
  return <section className="afterlife-panel"><header><Eye size={17} /><span><small>AFTERLIFE INVESTIGATION</small><b>사후 수사실</b></span></header><p>당신의 목소리는 생존자에게 닿지 않습니다. 사건 기록을 보고 최종 마피아 한 명을 봉인하거나, 이름 없는 유령 메시지를 남기세요.</p><div>{game.players.filter((player) => player.alive && player.id !== game.me.id).map((player) => <button key={player.id} className={game.me.ghost_prediction === player.id ? "active" : ""} onClick={() => onPredict(player.id)} disabled={game.phase === "gameover"}><span className={`avatar-photo avatar-${Math.max(0, game.players.indexOf(player)) % 12}`} /><b>{player.n}</b>{game.me.ghost_prediction === player.id && <Check size={13} />}</button>)}</div>{prediction && <footer className={game.phase === "gameover" ? game.me.ghost_correct ? "correct" : "wrong" : ""}><LockKeyhole size={13} /><span>{game.phase === "gameover" ? game.me.ghost_correct ? `${prediction.n} — 범인 예측 적중` : `${prediction.n} — 예측 실패` : `${prediction.n}님을 최종 범인으로 봉인했습니다`}</span></footer>}{game.me.ghost_message && <div className="ghost-message-sealed"><Sparkles size={13} />{game.me.ghost_message}</div>}{game.me.can_ghost_message && <form className="ghost-echo-form" onSubmit={onEcho}><input value={ghostText} onChange={(event) => setGhostText(event.target.value)} maxLength={120} placeholder="이름 없이, 마지막으로 본 흔적을 남기세요" /><button disabled={ghostText.trim().length < 5}><MessageCircle size={14} />유령 메시지</button></form>}</section>;
}

function PlayerCard({ player, index, self, host, accused, selected, selectable, speaking, suspicion, pressureCount, pressureMarkedByMe, canPressure, mark, phase, onSelect, onPressure }: { player: PlayerState; index: number; self: boolean; host: boolean; accused: boolean; selected: boolean; selectable: boolean; speaking: boolean; suspicion: number; pressureCount: number; pressureMarkedByMe: boolean; canPressure: boolean; mark: -1 | 0 | 1; phase: GameState["phase"]; onSelect: () => void; onPressure: () => void }) {
  return (
    <article className={`player-card ${!player.alive ? "dead" : ""} ${accused ? "accused" : ""} ${selected ? "selected" : ""} ${selectable ? "selectable" : ""} ${speaking ? "speaking" : ""} ${pressureMarkedByMe ? "pressure-marked" : ""}`} onClick={selectable ? onSelect : undefined} role={selectable ? "button" : undefined} tabIndex={selectable ? 0 : undefined} onKeyDown={(event) => { if (selectable && (event.key === "Enter" || event.key === " ")) onSelect(); }}>
      <div className="portrait"><span>{String(index + 1).padStart(2, "0")}</span><b className={`avatar-photo avatar-${index % 12}`} aria-label={`${player.n}의 증거물 토큰`} />{player.connected && <i />}{mark !== 0 && <em className={`intel-mark ${mark === -1 ? "suspect" : "safe"}`}>{mark === -1 ? "의심" : "안전"}</em>}</div>
      {speaking && <div className="speaker-pulse"><i /><i /><i /><span>발언 중</span></div>}
      <div className="player-info"><div><strong>{player.n}</strong>{self && <small>나</small>}{host && <small>방장</small>}{player.bot && <small>AI</small>}{player.bot && player.bot_persona && <small className="bot-persona-label">{player.bot_persona}</small>}{player.voice && <Mic className="voice-presence-icon" size={12} />}{player.mafia && <Skull size={13} />}{player.id && phase === "gameover" && player.role && <small>{ROLE_META[player.role].name}</small>}</div><span>{!player.alive ? "사망" : phase === "lobby" ? host ? "시작 권한 보유" : player.ready ? "준비 완료" : "대기 중" : suspicion > 60 ? "집중 수사 대상" : "생존"}</span></div>
      {phase !== "lobby" && player.alive && <div className="suspicion-meter" aria-label={`공개 의심도 ${suspicion}%`}><i style={{ width: `${suspicion}%` }} /><span>의심 {suspicion}%</span></div>}
      {(pressureCount > 0 || pressureMarkedByMe) && <div className="pressure-count"><Crosshair size={11} />{pressureMarkedByMe ? "내 긴급 지목" : `${pressureCount} 압박`}</div>}
      {canPressure && <button className="pressure-action" type="button" onClick={(event) => { event.stopPropagation(); onPressure(); }}><Crosshair size={12} />긴급 지목</button>}
      {player.votes > 0 && <div className="vote-count">{player.votes}표</div>}
      {accused && <div className="accused-mark"><Gavel size={12} />피고</div>}
      {selected && <div className="selected-mark"><Check size={14} /></div>}
    </article>
  );
}
