export type Role = "mafia" | "doctor" | "detective" | "bodyguard" | "trickster" | "citizen" | "spectator";
export type Phase = "lobby" | "reveal" | "night" | "dawn" | "day" | "vote" | "defense" | "verdict" | "result" | "gameover";

export type PlayerState = {
  id: string;
  n: string;
  alive: boolean;
  connected: boolean;
  ready: boolean;
  votes: number;
  mafia: boolean;
  role: Role | null;
  bot: boolean;
  score: number;
  voice: boolean;
};

export type ChatMessage = { id: string; from: string; text: string; at: number };
export type ReactionState = { id: string; from: string; emoji: string; at: number };
export type ReadStance = "trust" | "hold" | "suspect";
export type InterrogationQuestion = { id: string; from: string; from_id: string; speaker_id: string; text: string; round: number; at: number };
export type SealedClaim = { id: string; speaker_id: string; speaker: string; text: string; round: number; at: number };
export type CaseMoment = { id: string; kind: string; text: string; actor: string | null; target: string | null; round: number };

export type GameState = {
  t: "state";
  room: string;
  phase: Phase;
  round: number;
  deadline: number;
  winner: "mafia" | "citizen" | "trickster" | null;
  pace: "quick" | "classic";
  host: string | null;
  min_players: number;
  max_players: number;
  players: PlayerState[];
  me: {
    id: string;
    role: Role;
    alive: boolean;
    action_target: string | null;
    vote_target: string | null;
    judgement?: boolean | null;
    intel: string[];
    mission: string;
    reads: Record<string, ReadStance>;
    can_leave_will: boolean;
  };
  story: string[];
  case_log: string[];
  accused_id: string | null;
  judgement_counts: { execute: number; spare: number };
  decision_progress: { completed: number; total: number };
  guide: string;
  chat: ChatMessage[];
  reactions: ReactionState[];
  speaker_id: string | null;
  speaker_deadline: number;
  interrogation_order: string[];
  questions: InterrogationQuestion[];
  claims: SealedClaim[];
  read_summary: Record<string, Record<ReadStance, number>>;
  moments: CaseMoment[];
};

export type WelcomeMsg = {
  t: "welcome";
  id: string;
  nick: string;
  room: string;
  player_key: string;
  signed_in: boolean;
  resumed: boolean;
};
