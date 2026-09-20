import { createRng, hashSeed } from './rng.js';
import { computeResult } from './scoring.js';
import {
  RuleError,
  type AgentId,
  type DiscussionAction,
  type GameState,
  type Interest,
  type PendingAction,
  type ProposalAction,
  type TreasureId,
  type VoteAction,
  type WhispersAction,
} from './types.js';

const INTERESTS: readonly Interest[] = ['want', 'meh', 'avoid'];

/** Who must act right now. Empty when the game is over. */
export function pendingActions(state: GameState): PendingAction[] {
  const { phase, current } = state;
  const round = current.round;
  switch (phase) {
    case 'discussion': {
      const next = current.speakOrder.find((a) => !current.spoken.includes(a));
      return next ? [{ agent: next, phase, round }] : [];
    }
    case 'whispers':
      return state.agents
        .filter((a) => !current.whispered.includes(a.id))
        .map((a) => ({ agent: a.id, phase, round }));
    case 'proposal':
      return [{ agent: current.proposer, phase, round }];
    case 'vote':
      return state.agents
        .filter((a) => !(a.id in current.votes))
        .map((a) => ({ agent: a.id, phase, round }));
    case 'ended':
      return [];
  }
}

/**
 * Apply one agent's action. Returns a new state; the input is not mutated.
 * Throws RuleError with a message suitable for feeding back to the agent.
 */
export function applyAction(state: GameState, agent: AgentId, raw: unknown, now: string = new Date().toISOString()): GameState {
  const pending = pendingActions(state);
  if (!pending.some((p) => p.agent === agent)) {
    throw new RuleError(`It is not ${agent}'s turn to act (phase: ${state.phase}).`);
  }
  if (!isRecord(raw)) throw new RuleError('Action must be a JSON object.');

  const next: GameState = structuredClone(state);
  const round = next.current.round;
  const notes = clampText(strField(raw, 'notes', true), next.config.maxNotesChars);
  next.events.push({ type: 'notes', round, phase: next.phase, agent, text: notes });

  switch (next.phase) {
    case 'discussion':
      applyDiscussion(next, agent, raw);
      break;
    case 'whispers':
      applyWhispers(next, agent, raw);
      break;
    case 'proposal':
      applyProposal(next, agent, raw);
      break;
    case 'vote':
      applyVote(next, agent, raw);
      break;
    case 'ended':
      throw new RuleError('The game is over.');
  }
  advance(next, now);
  return next;
}

/* ---- phase handlers ---- */

function applyDiscussion(state: GameState, agent: AgentId, raw: Record<string, unknown>): void {
  const say = clampText(strField(raw, 'say'), state.config.maxSayChars);
  if (say.trim().length === 0) throw new RuleError('"say" must not be empty.');
  const interests = parseInterests(state, raw['interests']);
  state.events.push({ type: 'say', round: state.current.round, agent, text: say, interests });
  state.current.spoken.push(agent);
}

function applyWhispers(state: GameState, agent: AgentId, raw: Record<string, unknown>): void {
  const list = raw['whispers'] ?? [];
  if (!Array.isArray(list)) throw new RuleError('"whispers" must be an array.');
  if (list.length > state.config.maxWhispersPerRound) {
    throw new RuleError(`At most ${state.config.maxWhispersPerRound} whispers per round.`);
  }
  const seen = new Set<AgentId>();
  const parsed = list.map((w, i) => {
    if (!isRecord(w)) throw new RuleError(`whispers[${i}] must be an object.`);
    const to = strField(w, 'to');
    if (to === agent) throw new RuleError('You cannot whisper to yourself.');
    if (!state.agents.some((a) => a.id === to)) throw new RuleError(`Unknown agent "${to}".`);
    if (seen.has(to)) throw new RuleError(`Only one whisper per recipient per round ("${to}").`);
    seen.add(to);
    const text = clampText(strField(w, 'text'), state.config.maxWhisperChars);
    if (text.trim().length === 0) throw new RuleError(`whispers[${i}].text must not be empty.`);
    return { to, text };
  });
  for (const w of parsed) {
    state.events.push({ type: 'whisper', round: state.current.round, from: agent, to: w.to, text: w.text });
  }
  state.current.whispered.push(agent);
}

function applyProposal(state: GameState, agent: AgentId, raw: Record<string, unknown>): void {
  const alloc = raw['allocation'];
  if (!isRecord(alloc)) throw new RuleError('"allocation" must be an object mapping treasure id to agent id.');
  const allocation: Record<TreasureId, AgentId> = {};
  for (const [treasure, to] of Object.entries(alloc)) {
    if (!state.table.includes(treasure)) {
      throw new RuleError(`Treasure "${treasure}" is not on the table. On the table: ${state.table.join(', ')}.`);
    }
    if (typeof to !== 'string' || !state.agents.some((a) => a.id === to)) {
      throw new RuleError(`Unknown recipient "${String(to)}" for treasure "${treasure}".`);
    }
    allocation[treasure] = to;
  }
  if (Object.keys(allocation).length === 0) throw new RuleError('A proposal must allocate at least one treasure.');
  const pitch = clampText(strField(raw, 'pitch', true), state.config.maxSayChars);
  state.current.proposal = { proposer: agent, allocation, pitch };
  state.events.push({ type: 'proposal', round: state.current.round, proposer: agent, allocation, pitch });
}

function applyVote(state: GameState, agent: AgentId, raw: Record<string, unknown>): void {
  const vote = raw['vote'];
  if (vote !== 'yes' && vote !== 'no') throw new RuleError('"vote" must be "yes" or "no".');
  const reason = clampText(strField(raw, 'reason', true), state.config.maxSayChars);
  state.current.votes[agent] = vote === 'yes';
  state.events.push({ type: 'vote', round: state.current.round, agent, yes: vote === 'yes', reason });
}

/* ---- phase transitions ---- */

function advance(state: GameState, now: string): void {
  const cur = state.current;
  const n = state.agents.length;
  switch (state.phase) {
    case 'discussion':
      if (cur.spoken.length === n) state.phase = 'whispers';
      return;
    case 'whispers':
      if (cur.whispered.length === n) state.phase = 'proposal';
      return;
    case 'proposal':
      if (cur.proposal) state.phase = 'vote';
      return;
    case 'vote':
      if (Object.keys(cur.votes).length === n) resolveVote(state, now);
      return;
    case 'ended':
      return;
  }
}

function resolveVote(state: GameState, now: string): void {
  const cur = state.current;
  const round = cur.round;
  const yes = state.agents.filter((a) => cur.votes[a.id] === true).map((a) => a.id);
  const no = state.agents.filter((a) => cur.votes[a.id] === false).map((a) => a.id);
  const passed = yes.length * 2 > state.agents.length;
  state.events.push({ type: 'vote_result', round, passed, yes, no });

  if (passed && cur.proposal) {
    const allocation = cur.proposal.allocation;
    for (const [treasure, to] of Object.entries(allocation)) {
      state.table = state.table.filter((t) => t !== treasure);
      (state.holdings[to] ??= []).push(treasure);
    }
    state.events.push({ type: 'transfer', round, allocation });
  } else if (state.table.length > 0) {
    const rng = createRng(hashSeed(`${state.seed}:${round}:rot`));
    const treasure = rng.pick(state.table);
    state.table = state.table.filter((t) => t !== treasure);
    state.rotted.push(treasure);
    state.events.push({ type: 'rot', round, treasure, reason: 'rejected' });
  }

  if (round >= state.config.rounds || state.table.length === 0) {
    endGame(state, now);
    return;
  }

  const nextRound = round + 1;
  const order = state.agents.map((a) => a.id);
  const proposerIdx = (nextRound - 1) % order.length;
  const speakOrder = [...order.slice(proposerIdx), ...order.slice(0, proposerIdx)];
  state.current = {
    round: nextRound,
    proposer: speakOrder[0] as AgentId,
    speakOrder,
    spoken: [],
    whispered: [],
    votes: {},
  };
  state.phase = 'discussion';
  state.events.push({ type: 'round_started', round: nextRound, proposer: state.current.proposer });
}

function endGame(state: GameState, now: string): void {
  const round = state.current.round;
  for (const treasure of state.table) {
    state.rotted.push(treasure);
    state.events.push({ type: 'rot', round, treasure, reason: 'final' });
  }
  state.table = [];
  const result = computeResult(state);
  const at = now;
  state.result = result;
  state.endedAt = at;
  state.phase = 'ended';
  state.events.push({ type: 'game_ended', at, ...result });
}

/* ---- parsing helpers ---- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strField(obj: Record<string, unknown>, key: string, optional = false): string {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (optional) return '';
    throw new RuleError(`Missing required field "${key}".`);
  }
  if (typeof v !== 'string') throw new RuleError(`Field "${key}" must be a string.`);
  return v;
}

function clampText(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function parseInterests(state: GameState, raw: unknown): Record<TreasureId, Interest> {
  const out: Record<TreasureId, Interest> = {};
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) throw new RuleError('"interests" must be an object mapping treasure id to want|meh|avoid.');
  for (const [treasure, v] of Object.entries(raw)) {
    if (!state.table.includes(treasure)) continue; // silently ignore stale ids
    if (typeof v !== 'string' || !INTERESTS.includes(v as Interest)) {
      throw new RuleError(`interests["${treasure}"] must be one of want, meh, avoid.`);
    }
    out[treasure] = v as Interest;
  }
  return out;
}

/* Re-exported for callers that want to build typed actions. */
export type { DiscussionAction, WhispersAction, ProposalAction, VoteAction };
