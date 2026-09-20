export type AgentId = string;
export type TreasureId = string;

export type Interest = 'want' | 'meh' | 'avoid';

export interface AgentInfo {
  id: AgentId;
  name: string;
  seat: number;
  model?: string;
  author?: string;
}

export interface Treasure {
  id: TreasureId;
  name: string;
  emoji: string;
  blurb: string;
}

export interface Card {
  /** Secret value of each treasure to this agent. Negative means poison. */
  values: Record<TreasureId, number>;
}

export type Phase = 'discussion' | 'whispers' | 'proposal' | 'vote' | 'ended';

export interface Whisper {
  from: AgentId;
  to: AgentId;
  text: string;
}

export interface Proposal {
  proposer: AgentId;
  allocation: Record<TreasureId, AgentId>;
  pitch: string;
}

export type GameEvent =
  | { type: 'game_created'; at: string }
  | { type: 'round_started'; round: number; proposer: AgentId }
  | { type: 'notes'; round: number; phase: Phase; agent: AgentId; text: string }
  | { type: 'say'; round: number; agent: AgentId; text: string; interests: Record<TreasureId, Interest> }
  | { type: 'whisper'; round: number; from: AgentId; to: AgentId; text: string }
  | { type: 'proposal'; round: number; proposer: AgentId; allocation: Record<TreasureId, AgentId>; pitch: string }
  | { type: 'vote'; round: number; agent: AgentId; yes: boolean; reason: string }
  | { type: 'vote_result'; round: number; passed: boolean; yes: AgentId[]; no: AgentId[] }
  | { type: 'transfer'; round: number; allocation: Record<TreasureId, AgentId> }
  | { type: 'rot'; round: number; treasure: TreasureId; reason: 'rejected' | 'final' }
  | { type: 'game_ended'; at: string; scores: Record<AgentId, number>; ranks: Record<AgentId, number>; winners: AgentId[] };

export interface GameConfig {
  rounds: number;
  /** Most treasures one proposal may move. Undefined means unlimited (games recorded before the cap). */
  maxPerProposal?: number;
  maxWhispersPerRound: number;
  maxSayChars: number;
  maxWhisperChars: number;
  maxNotesChars: number;
}

export interface RoundState {
  round: number;
  proposer: AgentId;
  /** Seat order for discussion, starting at proposer. */
  speakOrder: AgentId[];
  spoken: AgentId[];
  whispered: AgentId[];
  proposal?: Proposal;
  votes: Record<AgentId, boolean>;
}

export interface GameResult {
  scores: Record<AgentId, number>;
  ranks: Record<AgentId, number>;
  winners: AgentId[];
}

export type GameMode = 'live' | 'scripted';

export interface GameState {
  version: 1;
  id: string;
  /** live = language-model players; scripted = heuristic bots (excluded from the leaderboard). */
  mode: GameMode;
  seed: number;
  createdAt: string;
  endedAt?: string;
  config: GameConfig;
  agents: AgentInfo[];
  treasures: Treasure[];
  cards: Record<AgentId, Card>;
  table: TreasureId[];
  holdings: Record<AgentId, TreasureId[]>;
  rotted: TreasureId[];
  phase: Phase;
  current: RoundState;
  events: GameEvent[];
  /** Per agent: index of the first event not yet shown to them. Maintained by markSeen. */
  seen?: Record<AgentId, number>;
  result?: GameResult;
}

/* ---- Actions agents submit ---- */

export interface DiscussionAction {
  notes: string;
  say: string;
  interests?: Record<TreasureId, Interest>;
}

export interface WhispersAction {
  notes: string;
  whispers: { to: AgentId; text: string }[];
}

export interface ProposalAction {
  notes: string;
  allocation: Record<TreasureId, AgentId>;
  pitch: string;
}

export interface VoteAction {
  notes: string;
  vote: 'yes' | 'no';
  reason: string;
}

export type AgentAction = DiscussionAction | WhispersAction | ProposalAction | VoteAction;

export interface PendingAction {
  agent: AgentId;
  phase: Exclude<Phase, 'ended'>;
  round: number;
}

export class RuleError extends Error {
  override name = 'RuleError';
}
