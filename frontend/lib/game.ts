export type Role = "mafia" | "doctor" | "detective" | "bodyguard" | "trickster" | "citizen" | "spectator";
export type Phase = "lobby" | "reveal" | "night" | "dawn" | "day" | "vote" | "result" | "gameover";

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
};

export type ChatMessage = { id: string; from: string; text: string; at: number };

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
    intel: string[];
    mission: string;
  };
  story: string[];
  guide: string;
  chat: ChatMessage[];
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
