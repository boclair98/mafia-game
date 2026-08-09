"use client";

import {
  Activity, Bot, Check, ChevronLeft, ChevronRight, Clipboard, Crosshair, Download, Eye, Film,
  HeartPulse, LockKeyhole, LogIn, MessageCircle, Moon, Radio, RotateCcw, Search, Send, Siren,
  Share2, ShieldCheck, ShieldQuestion, Skull, Smartphone, Sparkles,
  TimerReset, UserPlus, Users, Volume2, VolumeX, Vote, X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { GameState, PlayerState, Role, WelcomeMsg } from "@/lib/game";
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

const PHASE_META = {
  lobby: ["용의자 대기실", "모두가 정체를 숨기면 자정의 사건이 시작됩니다."],
  reveal: ["역할 확인", "당신의 정체는 오직 당신만 볼 수 있습니다."],
  night: ["밤", "고개를 숙이고 자신의 행동을 선택하세요."],
  dawn: ["새벽", "밤사이 도시에 무슨 일이 있었을까요?"],
  day: ["낮 · 토론", "대화 속 모순을 찾아 마피아를 추리하세요."],
  vote: ["시민 투표", "가장 의심스러운 한 사람을 지목하세요."],
  result: ["투표 결과", "도시의 선택이 공개됩니다."],
  gameover: ["게임 종료", "승패가 결정되었습니다."],
} as const;

const PHASE_ALERT_META: Record<GameState["phase"], { kicker: string; title: string; copy: string; icon: typeof Moon }> = {
  lobby: { kicker: "CASE LOBBY", title: "용의자 대기실", copy: "친구를 초대하고 모두 준비해 주세요.", icon: Users },
  reveal: { kicker: "IDENTITY REVEALED", title: "배역이 공개되었습니다", copy: "이 정체는 오직 당신만 볼 수 있습니다.", icon: ShieldQuestion },
  night: { kicker: "NIGHT HAS FALLEN", title: "밤이 되었습니다", copy: "말을 멈추고 자신의 능력을 선택하세요.", icon: Moon },
  dawn: { kicker: "DAWN REPORT", title: "새벽이 밝았습니다", copy: "밤사이 벌어진 사건이 곧 공개됩니다.", icon: Eye },
  day: { kicker: "OPEN DISCUSSION", title: "토론이 시작되었습니다", copy: "주장의 모순을 찾고 가장 수상한 사람을 추리하세요.", icon: MessageCircle },
  vote: { kicker: "FINAL BALLOT", title: "시민 투표가 시작됩니다", copy: "처형할 용의자 한 명을 선택하세요.", icon: Vote },
  result: { kicker: "VERDICT", title: "판결을 집행합니다", copy: "도시의 선택과 정체가 공개됩니다.", icon: Skull },
  gameover: { kicker: "CASE CLOSED", title: "사건이 종료되었습니다", copy: "승리 팀과 모든 배역을 확인하세요.", icon: Sparkles },
};

const PHASE_NARRATION: Record<GameState["phase"], string> = {
  lobby: "용의자 대기실입니다. 참가자가 모두 준비되면 사건을 시작하십시오.",
  reveal: "배역이 공개되었습니다. 자신의 정체를 숨기고, 첫 번째 밤을 준비하십시오.",
  night: "밤이 되었습니다. 모두 눈을 감고, 역할이 있는 사람만 조용히 행동하십시오.",
  dawn: "새벽이 밝았습니다. 밤사이 발생한 사건 보고를 확인합니다.",
  day: "토론을 시작합니다. 발언 속 거짓말과 모순을 찾아내십시오.",
  vote: "시민 투표를 시작합니다. 처형할 용의자 한 명을 선택하십시오.",
  result: "투표를 마감합니다. 도시의 판결을 공개합니다.",
  gameover: "사건이 종료되었습니다. 승리 팀과 최종 사건 기록을 확인하십시오.",
};

const PHASE_TRACK: GameState["phase"][] = ["reveal", "night", "dawn", "day", "vote", "result"];
const PHASE_THREAT: Record<GameState["phase"], number> = { lobby: 8, reveal: 24, night: 72, dawn: 58, day: 42, vote: 82, result: 94, gameover: 100 };
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };

const TUTORIAL_SCENES = [
  { tag: "SCENE 01 · 정체", title: "밤에는 역할이 움직입니다", copy: "마피아는 습격하고, 의사와 경호원은 누군가를 지키며, 탐정은 단 한 명의 진실을 확인합니다.", icon: Moon },
  { tag: "SCENE 02 · 심문", title: "낮에는 말이 증거입니다", copy: "누구를 선택했는지 묻고 이전 주장과 비교하세요. AI 진행자가 현재 역할에 필요한 질문을 바로 알려줍니다.", icon: MessageCircle },
  { tag: "SCENE 03 · 반전", title: "수상하다고 모두 마피아는 아닙니다", copy: "광대는 시민 투표로 처형되면 혼자 승리합니다. 표를 던지기 전 동기와 행동 결과를 함께 확인하세요.", icon: Sparkles },
  { tag: "SCENE 04 · 판결", title: "모든 거짓말은 사건 파일에 남습니다", copy: "게임이 끝나면 역할과 사건 기록을 되짚어 보세요. 다음 판에는 같은 거짓말이 통하지 않을 겁니다.", icon: Vote },
];

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
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);
  const [copied, setCopied] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [stats, setStats] = useState<LocalStats>({ games: 0, wins: 0, streak: 0 });
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [evidence, setEvidence] = useState<Record<string, -1 | 0 | 1>>({});
  const [phaseAlert, setPhaseAlert] = useState<GameState["phase"] | null>(null);
  const [decisionFlash, setDecisionFlash] = useState<{ label: string; target: string } | null>(null);
  const previousPhase = useRef<string | null>(null);
  const phaseAlertTimer = useRef<number | null>(null);
  const decisionFlashTimer = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const soundPhase = game?.phase;

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      setRoomInput(params.get("room") || makeRoom());
      setNick(localStorage.getItem("black-midnight:nick") || "");
      const savedStats = localStorage.getItem("black-midnight:stats");
      if (savedStats) setStats(JSON.parse(savedStats) as LocalStats);
      if (!localStorage.getItem("black-midnight:tutorial-seen")) setTutorialOpen(true);
      setVoiceOn(localStorage.getItem("black-midnight:voice") === "1");
      setSoundOn(localStorage.getItem("black-midnight:sound") === "1");
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
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [game?.chat.length]);

  useEffect(() => {
    if (!game) return;
    const changed = previousPhase.current ? previousPhase.current !== game.phase : game.phase !== "lobby";
    if (changed) {
      setPhaseAlert(game.phase);
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
      day: [330, 440], vote: [170, 170, 220], result: [120, 90], gameover: [196, 294, 392],
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
    if (!tutorialOpen) return;
    const timer = window.setInterval(() => setTutorialStep((step) => Math.min(step + 1, TUTORIAL_SCENES.length - 1)), 6500);
    return () => window.clearInterval(timer);
  }, [tutorialOpen]);

  useEffect(() => {
    if (!voiceOn || !soundPhase || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const line = new SpeechSynthesisUtterance(PHASE_NARRATION[soundPhase]);
    const voices = window.speechSynthesis.getVoices();
    const koreanVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith("ko"));
    line.voice = koreanVoices.find((voice) => /(injoon|hyunsu|male|남성|natural|neural)/i.test(voice.name))
      ?? koreanVoices.find((voice) => /(google|microsoft|apple)/i.test(voice.name))
      ?? koreanVoices[0]
      ?? null;
    line.lang = "ko-KR";
    line.rate = 0.82;
    line.pitch = 0.72;
    line.volume = 0.92;
    window.speechSynthesis.speak(line);
    return () => window.speechSynthesis.cancel();
  }, [soundPhase, voiceOn]);

  useEffect(() => {
    if (!joined || !room || !nick) return;
    const key = getPlayerKey(room);
    const socket = new GameSocket(gameSocketUrl(room, nick, key), {
      onStatus: setStatus,
      onMessage: (raw) => {
        const msg = raw as WelcomeMsg | GameState | { t: "error"; message: string };
        if (msg.t === "welcome") {
          setWelcome(msg as WelcomeMsg);
        } else if (msg.t === "state") {
          const next = msg as GameState;
          setGame(next);
          setSelected((current) => current && next.players.some((p) => p.id === current && p.alive) ? current : null);
        } else if (msg.t === "error") {
          setNotice(msg.message);
          window.setTimeout(() => setNotice(""), 3200);
        }
      },
    });
    socketRef.current = socket;
    return () => socket.close();
  }, [joined, room, nick]);

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    const safeNick = nick.trim().slice(0, 16);
    const safeRoom = roomInput.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || makeRoom();
    if (!safeNick) return;
    localStorage.setItem("black-midnight:nick", safeNick);
    history.replaceState(null, "", `?room=${encodeURIComponent(safeRoom)}`);
    setNick(safeNick);
    setRoom(safeRoom);
    setJoined(true);
  };

  const send = (message: object) => socketRef.current?.send(message);
  const me = game?.players.find((player) => player.id === game.me.id);
  const role = game?.me.role || "citizen";
  const roleMeta = ROLE_META[role];
  const RoleIcon = roleMeta.icon;
  const phase = game ? PHASE_META[game.phase] : PHASE_META.lobby;
  const remaining = game ? secondsLeft(game.deadline, now) : 0;
  const alertMeta = phaseAlert ? PHASE_ALERT_META[phaseAlert] : null;
  const PhaseAlertIcon = alertMeta?.icon ?? Moon;
  const phaseProgressIndex = game?.phase === "gameover" ? PHASE_TRACK.length : game ? PHASE_TRACK.indexOf(game.phase) : -1;
  const selectedPlayer = game?.players.find((player) => player.id === selected) ?? null;
  const selectedPlayerIndex = selectedPlayer && game ? game.players.findIndex((player) => player.id === selectedPlayer.id) : 0;
  const urgencyBoost = remaining > 0 && remaining <= 10 ? (10 - remaining) * 2 : 0;
  const cityThreat = game ? Math.min(100, PHASE_THREAT[game.phase] + urgencyBoost) : 0;
  const aliveCount = game?.players.filter((player) => player.alive).length ?? 0;
  const lostCount = game ? game.players.length - aliveCount : 0;
  const canChat = game && ["lobby", "day", "vote", "gameover"].includes(game.phase)
    || game?.phase === "night" && role === "mafia" && game.me.alive;

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
    : game.phase === "day" ? "발언의 모순을 추리 보드에 표시하고 직접 질문하세요."
    : game.phase === "vote" ? "개인 기록과 공개 발언을 대조한 뒤 최종 표를 봉인하세요."
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
    image.src = "/midnight-city-ui.png";
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

  const submitChat = (event: FormEvent) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    send({ t: "chat", text });
    setChatText("");
  };

  if (!joined) {
    return (
      <main className="landing-shell">
        <div className="grain" />
        <header className="landing-nav"><div><Moon size={17} fill="currentColor" /><b>검은 자정</b></div><span><i />CITY NETWORK ONLINE</span></header>
        <div className="city-coordinate"><span>37°34&apos;N · 126°58&apos;E</span><b>MIDNIGHT DISTRICT / LIVE FEED 00:42</b></div>
        <section className="landing-copy">
          <div className="eyebrow"><span /> LIVE SOCIAL DEDUCTION · SEASON 3</div>
          <h1><span>검은</span> <em>자정</em></h1>
          <p className="hero-line">이 도시의 누군가는 마피아다.</p>
          <div className="mafia-warning"><Skull size={18} /><span><b>WHO IS LYING?</b><small>정체를 감추고, 거짓말을 찾아, 자정까지 살아남아라.</small></span><i>CASE 00</i></div>
          <div className="role-strip">
            <div className="landing-role role-mafia-card"><div className="role-face avatar-photo avatar-2" /><span><small>ROLE 01</small><b>마피아</b><em>밤의 살인자</em></span></div>
            <div className="landing-role"><div className="role-face avatar-photo avatar-5" /><span><small>ROLE 02</small><b>탐정</b><em>진실의 추적자</em></span></div>
            <div className="landing-role"><div className="role-face avatar-photo avatar-8" /><span><small>ROLE 03</small><b>시민</b><em>표적 또는 증인</em></span></div>
          </div>
          <div className="local-stats"><div><b>{stats.games}</b><span>플레이</span></div><div><b>{stats.wins}</b><span>승리</span></div><div><b>{stats.streak}</b><span>연승</span></div></div>
          <button className="briefing-launch" type="button" onClick={() => { setTutorialStep(0); setTutorialOpen(true); }}><Film size={16} /><span><b>3분 AI 모션 브리핑</b><small>룰을 몰라도 한 번에 이해하기</small></span><ChevronRight size={16} /></button>
        </section>
        <section className="join-card">
          <div className="join-card-top">
            <span>PRIVATE TABLE</span>
            <span className="live-dot">온라인</span>
          </div>
          <h2>테이블에 앉기</h2>
          <p>설치 없이 링크 하나로 최대 12명이 함께합니다.</p>
          <div className="join-warning"><Skull size={14} /><span>입장 후 배역은 봉인됩니다. 아무도 믿지 마세요.</span></div>
          <form onSubmit={submitJoin}>
            <label>당신의 이름<input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="예: 수상한 철수" maxLength={16} autoFocus /></label>
            <label>비밀 방 코드<div className="room-field"><input value={roomInput} onChange={(e) => setRoomInput(e.target.value)} maxLength={32} /><button type="button" onClick={() => setRoomInput(makeRoom())}><RotateCcw size={15} /></button></div></label>
            <button className="primary-button join-enter-button" type="submit" disabled={!nick.trim()}><LogIn size={18} /><span>용의자 명단에 입장</span></button>
          </form>
          {installPrompt && <button className="install-button" type="button" onClick={installApp}><Smartphone size={16} /> 홈 화면에 앱 설치</button>}
          <div className="join-foot"><Users size={15} /> 최소 4명 · AI 채우기 지원 · 모바일 설치 가능</div>
        </section>
        {tutorialOpen && <TutorialModal step={tutorialStep} setStep={setTutorialStep} onClose={closeTutorial} />}
      </main>
    );
  }

  if (!game || !welcome) {
    return <main className="loading-screen"><Moon className="moon-loader" /><p>도시의 불을 끄는 중…</p></main>;
  }

  return (
    <main className={`game-shell phase-${game.phase} ${remaining > 0 && remaining <= 10 && game.phase !== "reveal" ? "is-urgent" : ""}`}>
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
            {voiceOn && <div className="phase-alert-voice"><Volume2 size={13} /><span>{PHASE_NARRATION[phaseAlert]}</span></div>}
            {remaining > 0 && <div className="phase-alert-countdown"><b>{remaining}</b><span>초 남음</span></div>}
            <div className="phase-alert-line"><i /></div>
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="mini-brand"><Moon size={18} fill="currentColor" /><span>검은 자정</span><button className="guide-button" onClick={() => { setTutorialStep(0); setTutorialOpen(true); }}><Film size={13} />룰 안내</button><button className={`guide-button ${voiceOn ? "active" : ""}`} onClick={toggleVoice} aria-label="게임 진행 음성 켜기 또는 끄기">{voiceOn ? <Volume2 size={13} /> : <VolumeX size={13} />}진행 음성</button><button className={`guide-button ${soundOn ? "active" : ""}`} onClick={toggleSound} aria-label="게임 효과음 켜기 또는 끄기">{soundOn ? <Radio size={13} /> : <VolumeX size={13} />}효과음</button></div>
        <div className="room-pill"><span>ROOM</span><b>{room}</b><button onClick={copyInvite} aria-label="초대 링크 복사">{copied ? <Check size={15} /> : <Clipboard size={15} />}</button><button onClick={() => setInviteOpen(true)} aria-label="친구 초대 열기"><UserPlus size={15} /></button></div>
        <div className={`connection ${status}`}><i />{status === "open" ? `${game.players.filter((p) => p.connected).length}명 접속` : "재연결 중"}</div>
      </header>

      <section className="phase-banner">
        <div className="threat-monitor"><div><Siren size={14} /><span>CITY THREAT</span><b>{cityThreat}%</b></div><div className="threat-bar"><i style={{ width: `${cityThreat}%` }} /></div><small>{aliveCount} ALIVE · {lostCount} LOST</small></div>
        <div className="phase-kicker">{game.round ? `DAY ${game.round}` : "WAITING ROOM"}</div>
        <h1>{phase[0]}</h1>
        <p>{phase[1]}</p>
        <div className="phase-now"><i /><b>{PHASE_ALERT_META[game.phase].title}</b><span>{remaining > 0 ? `${remaining}초 남음` : game.phase === "lobby" ? "시작 대기 중" : "진행 중"}</span></div>
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
          <div className="player-grid">
            {game.players.map((player, index) => (
              <PlayerCard key={player.id} player={player} index={index} self={player.id === game.me.id} selected={selected === player.id} selectable={targetPlayers.some((p) => p.id === player.id)} mark={evidence[player.id] ?? 0} phase={game.phase} onSelect={() => setSelected(player.id)} />
            ))}
            {game.phase === "lobby" && Array.from({ length: Math.max(0, game.min_players - game.players.length) }).map((_, i) => <div className="empty-seat" key={i}><span>+</span><p>빈자리</p></div>)}
          </div>

          {selectedPlayer && ["night", "vote"].includes(game.phase) && <div className={`target-lock ${game.phase === "vote" ? "vote-lock" : ""}`}><div className={`target-lock-photo avatar-photo avatar-${Math.max(0, selectedPlayerIndex) % 12}`} /><Crosshair size={18} /><span><small>{game.phase === "vote" ? "EXECUTION CANDIDATE" : "TARGET LOCKED"}</small><b>{selectedPlayer.n}</b><em>{game.phase === "vote" ? "최종 투표 대상" : refinedActionCopy}</em></span><button onClick={() => setSelected(null)} aria-label="선택 대상 해제"><X size={15} /></button></div>}
          <div className="action-bar">
            {game.phase === "lobby" && (
              <>
                <div><b>{game.players.length}/{game.max_players}명 용의자 등록 · {game.pace === "quick" ? "퀵 8분" : "클래식 15분"}</b><span>모두 준비되면 역할이 비밀리에 배정되고 첫 번째 밤이 시작됩니다.</span></div>
                {game.host === game.me.id && <div className="pace-switch"><button className={game.pace === "quick" ? "active" : ""} onClick={() => send({ t: "pace", pace: "quick" })}><TimerReset size={14} />퀵</button><button className={game.pace === "classic" ? "active" : ""} onClick={() => send({ t: "pace", pace: "classic" })}>클래식</button></div>}
                {game.host === game.me.id && game.players.length < 6 && <button className="secondary-button" onClick={() => send({ t: "fill_bots", target: 6 })}><Bot size={17} />AI 6명 채우기</button>}
                <button className="secondary-button" onClick={() => setInviteOpen(true)}><UserPlus size={17} />친구 초대</button>
                <button className="secondary-button" onClick={() => send({ t: "ready" })}>{me?.ready ? <Check size={17} /> : <ShieldQuestion size={17} />}{me?.ready ? "준비 완료" : "준비하기"}</button>
                {game.host === game.me.id && <button className="primary-button compact start-game-button" disabled={game.players.length < game.min_players} onClick={() => send({ t: "start" })}><Skull size={17} /><span>게임 시작</span></button>}
              </>
            )}
            {game.phase === "night" && game.me.alive && ["mafia", "doctor", "detective", "bodyguard"].includes(role) && (
              <><div><b>{refinedActionCopy}을 선택하세요</b><span>시간 안에는 선택을 바꿀 수 있습니다.</span></div><button className="primary-button compact seal-button" disabled={!selected} onClick={() => commitDecision("action")}><LockKeyhole size={17} />{game.me.action_target ? "명령 변경" : "명령 봉인"}</button></>
            )}
            {game.phase === "night" && (!game.me.alive || role === "citizen") && <div><b>도시가 잠들었습니다</b><span>{game.me.alive ? "아침이 올 때까지 눈을 감고 기다리세요." : "남은 플레이어들의 밤을 지켜보고 있습니다."}</span></div>}
            {game.phase === "vote" && game.me.alive && <><div><b>처형할 사람을 선택하세요</b><span>현재 표는 실시간으로 공개됩니다.</span></div><button className="danger-button seal-button" disabled={!selected} onClick={() => commitDecision("vote")}><LockKeyhole size={17} />{game.me.vote_target ? "투표 변경" : "투표 봉인"}</button></>}
            {game.phase === "day" && <div><b>자유 토론 시간</b><span>누가 거짓말하고 있는지 질문하고 기억하세요.</span></div>}
            {["reveal", "dawn", "result"].includes(game.phase) && <div><b>{game.story.at(-1)}</b><span>잠시 후 다음 단계로 넘어갑니다.</span></div>}
            {game.phase === "gameover" && <><div><b>{game.winner === "mafia" ? "마피아 팀 승리" : game.winner === "trickster" ? "광대 단독 승리" : "시민 팀 승리"}</b><span>모든 역할이 공개되었습니다.</span></div><button className="secondary-button" onClick={() => createPoster("result")}><Share2 size={17} />사건 리포트</button>{game.host === game.me.id && <button className="primary-button compact" onClick={() => send({ t: "rematch" })}><RotateCcw size={17} />다시 하기</button>}</>}
          </div>
        </section>

        <aside className="comms-panel">
          <div className="story-card"><div className="panel-label">LIVE INCIDENT FEED</div><div className="ai-director"><div><Radio size={14} /><b>자정 관제실 · 실시간 지령</b><i /></div><p>{game.guide}</p></div><div className="story-list">{game.story.slice(-5).map((line, i) => <div key={`${line}-${i}`} className={i === Math.min(4, game.story.length - 1) ? "latest" : ""}><span>{String(Math.max(0, game.story.length - 5) + i + 1).padStart(2, "0")}</span><p>{line}</p></div>)}</div>{game.phase === "gameover" && <div className="case-file"><b>사건 파일 · 최종 배역</b><div>{game.players.filter((p) => p.role).map((p) => <span key={p.id}>{p.n} — {p.role ? ROLE_META[p.role].name : "?"}</span>)}</div></div>}</div>
          <div className="chat-card">
            <div className="chat-title"><div><MessageCircle size={16} /><b>{game.phase === "night" && role === "mafia" ? "마피아 비밀 채팅" : "테이블 대화"}</b></div><span>{canChat ? "대화 가능" : "침묵 중"}</span></div>
            <div className="chat-scroll">{game.chat.length === 0 && <div className="empty-chat">아직 대화가 없습니다.</div>}{game.chat.map((msg) => <div className="chat-message" key={msg.id}><b>{msg.from}</b><p>{msg.text}</p></div>)}<div ref={chatEndRef} /></div>
            <form className="chat-form" onSubmit={submitChat}><input value={chatText} onChange={(e) => setChatText(e.target.value)} disabled={!canChat} placeholder={canChat ? "메시지를 입력하세요" : "지금은 말할 수 없습니다"} maxLength={160} /><button disabled={!canChat || !chatText.trim()} aria-label="메시지 전송"><Send size={16} /></button></form>
          </div>
        </aside>
      </div>
      {tutorialOpen && <TutorialModal step={tutorialStep} setStep={setTutorialStep} onClose={closeTutorial} />}
      {inviteOpen && <InviteModal room={room} online={game.players.filter((player) => player.connected).length} copied={copied} onClose={() => setInviteOpen(false)} onCopy={copyInvite} onShare={shareInvite} onPoster={() => createPoster("invite")} />}
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

function PlayerCard({ player, index, self, selected, selectable, mark, phase, onSelect }: { player: PlayerState; index: number; self: boolean; selected: boolean; selectable: boolean; mark: -1 | 0 | 1; phase: GameState["phase"]; onSelect: () => void }) {
  return (
    <button type="button" className={`player-card ${!player.alive ? "dead" : ""} ${selected ? "selected" : ""} ${selectable ? "selectable" : ""}`} onClick={selectable ? onSelect : undefined} disabled={!selectable}>
      <div className="portrait"><span>{String(index + 1).padStart(2, "0")}</span><b className={`avatar-photo avatar-${index % 12}`} aria-label={`${player.n} 가상 인물 사진`} />{player.connected && <i />}{mark !== 0 && <em className={`intel-mark ${mark === -1 ? "suspect" : "safe"}`}>{mark === -1 ? "의심" : "안전"}</em>}</div>
      <div className="player-info"><div><strong>{player.n}</strong>{self && <small>나</small>}{player.bot && <small>AI</small>}{player.mafia && <Skull size={13} />}{player.id && phase === "gameover" && player.role && <small>{ROLE_META[player.role].name}</small>}</div><span>{!player.alive ? "사망" : phase === "lobby" ? player.ready ? "준비 완료" : "대기 중" : "생존"}</span></div>
      {player.votes > 0 && <div className="vote-count">{player.votes}표</div>}
      {selected && <div className="selected-mark"><Check size={14} /></div>}
    </button>
  );
}
