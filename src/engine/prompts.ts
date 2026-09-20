import { pendingActions } from './game.js';
import type { AgentId, GameEvent, GameState, Phase, TreasureId } from './types.js';

export interface PromptOptions {
  /** Persona and strategy text from the agent's definition file. */
  persona: string;
  /** Include rules, persona, and the whole visible transcript. */
  full: boolean;
}

export function rulesText(state: GameState): string {
  const n = state.agents.length;
  const majority = Math.floor(n / 2) + 1;
  return [
    `THE TABLE — rules`,
    `- ${n} players sit around a table holding ${state.treasures.length} treasures.`,
    `- Each player has a SECRET card giving a value to every treasure: one is worth 10, one 8, then 5, 4, 3, 1, 0, and exactly one is POISON worth -6. Cards differ per player. Nobody else can see yours.`,
    `- The game lasts ${state.config.rounds} rounds. Each round has four phases:`,
    `  1. DISCUSSION: in seat order starting with the round's proposer, each player says one thing in public. You may also declare interests (want / meh / avoid) per treasure. Declarations are public and may be lies.`,
    `  2. WHISPERS: everyone privately messages up to ${state.config.maxWhispersPerRound} other players at the same time. Whispers arrive before the proposal.`,
    `  3. PROPOSAL: the round's proposer names an allocation: any subset of the treasures still on the table, each given to a player (including themselves).`,
    `  4. VOTE: everyone votes yes or no simultaneously with a public one-line reason. ${majority} or more yes votes pass it and the treasures move. If it fails, one random treasure on the table ROTS and is gone forever.`,
    `- After the final round, everything still on the table rots.`,
    `- Your score is the sum of your card's values for the treasures you hold. Highest score wins. Being handed your poison costs you 6.`,
    `- Everything you say publicly and every whisper is recorded. Your private "notes" are never shown to other players.`,
    `- You are a player, not an assistant. Pursue your own score. Alliances, persuasion, bluffing, and betrayal are all legal.`,
  ].join('\n');
}

export function renderPrompt(state: GameState, agent: AgentId, opts: PromptOptions): string {
  const me = state.agents.find((a) => a.id === agent);
  if (!me) throw new Error(`unknown agent ${agent}`);
  const pending = pendingActions(state).find((p) => p.agent === agent);
  if (!pending) throw new Error(`${agent} has nothing to do right now`);

  const parts: string[] = [];
  if (opts.full) {
    parts.push(rulesText(state));
    parts.push(`\nYOU ARE ${me.name} (id: ${me.id}).\n${opts.persona.trim()}`);
    parts.push(`\nPLAYERS (seat order): ${state.agents.map((a) => `${a.name} [${a.id}]`).join(', ')}`);
  }
  parts.push(`\n${situation(state, agent)}`);
  const since = opts.full ? 0 : lastOwnEventIndex(state, agent) + 1;
  const transcript = renderTranscript(state, agent, since);
  parts.push(opts.full ? `\nTRANSCRIPT SO FAR:\n${transcript}` : `\nSINCE YOUR LAST TURN:\n${transcript}`);
  parts.push(`\n${request(state, agent, pending.phase)}`);
  return parts.join('\n');
}

function situation(state: GameState, agent: AgentId): string {
  const card = state.cards[agent];
  const lines: string[] = [];
  lines.push(`ROUND ${state.current.round} of ${state.config.rounds} — phase: ${state.phase.toUpperCase()} — proposer this round: ${name(state, state.current.proposer)}`);
  lines.push(`ON THE TABLE: ${state.table.length ? state.table.map((t) => treasureLabel(state, t)).join(', ') : '(nothing)'}`);
  lines.push(`YOUR SECRET CARD: ${state.treasures.map((t) => `${t.name}=${card?.values[t.id] ?? 0}`).join(', ')}`);
  const held = state.agents.map((a) => {
    const h = state.holdings[a.id] ?? [];
    return `${a.name}: ${h.length ? h.map((t) => treasureName(state, t)).join(', ') : '—'}`;
  });
  lines.push(`HOLDINGS: ${held.join(' | ')}`);
  if (state.rotted.length) lines.push(`ROTTED: ${state.rotted.map((t) => treasureName(state, t)).join(', ')}`);
  return lines.join('\n');
}

function request(state: GameState, agent: AgentId, phase: Exclude<Phase, 'ended'>): string {
  const others = state.agents.filter((a) => a.id !== agent).map((a) => a.id);
  const tableIds = state.table.join('|');
  const common = `Reply with ONE JSON object and nothing else. Always include "notes": your private plan and observations, in character (never shown to other players, max ${state.config.maxNotesChars} chars).`;
  switch (phase) {
    case 'discussion':
      return `${common}\nIt is your turn to speak.\n{"notes": "...", "say": "what you tell the table (max ${state.config.maxSayChars} chars)", "interests": {"<treasure id>": "want|meh|avoid", ...}}\n"interests" is optional and public; keys must be treasure ids on the table (${tableIds}).`;
    case 'whispers':
      return `${common}\nSend up to ${state.config.maxWhispersPerRound} private whispers (or none).\n{"notes": "...", "whispers": [{"to": "<agent id>", "text": "max ${state.config.maxWhisperChars} chars, longer is cut off"}]}\nValid recipients: ${others.join(', ')}.`;
    case 'proposal':
      return `${common}\nYou are the proposer. Allocate any subset of treasures on the table to players.\n{"notes": "...", "allocation": {"<treasure id>": "<agent id>", ...}, "pitch": "your public case for this split"}\nTreasure ids on the table: ${tableIds}. Player ids: ${state.agents.map((a) => a.id).join(', ')}.`;
    case 'vote': {
      const p = state.current.proposal;
      const summary = p
        ? Object.entries(p.allocation)
            .map(([t, to]) => `${treasureName(state, t)} → ${to === agent ? 'YOU' : name(state, to)}`)
            .join('; ')
        : '(none)';
      return `${common}\nVote on ${p?.proposer === agent ? 'your own' : `${name(state, p?.proposer ?? '')}'s`} proposal: ${summary}.\n{"notes": "...", "vote": "yes|no", "reason": "one public line"}`;
    }
  }
}

/** Events this agent is allowed to see, from a given index onward. */
export function visibleEvents(state: GameState, agent: AgentId, since = 0): { index: number; ev: GameEvent }[] {
  const out: { index: number; ev: GameEvent }[] = [];
  state.events.forEach((ev, index) => {
    if (index < since) return;
    switch (ev.type) {
      case 'notes':
        return; // never shown, not even one's own (the agent already has them in context)
      case 'whisper':
        if (ev.from === agent || ev.to === agent) out.push({ index, ev });
        return;
      case 'vote':
        return; // individual votes are revealed via vote_result
      default:
        out.push({ index, ev });
    }
  });
  return out;
}

function renderTranscript(state: GameState, agent: AgentId, since: number): string {
  const lines: string[] = [];
  for (const { ev } of visibleEvents(state, agent, since)) {
    const line = renderEvent(state, agent, ev);
    if (line) lines.push(line);
  }
  return lines.length ? lines.join('\n') : '(nothing yet)';
}

export function renderEvent(state: GameState, viewer: AgentId | null, ev: GameEvent): string | null {
  const n = (id: AgentId) => (id === viewer ? 'YOU' : name(state, id));
  switch (ev.type) {
    case 'game_created':
      return null;
    case 'round_started':
      return `— Round ${ev.round} begins. Proposer: ${n(ev.proposer)}.`;
    case 'say': {
      const ints = Object.entries(ev.interests)
        .map(([t, i]) => `${treasureName(state, t)}:${i}`)
        .join(', ');
      return `${n(ev.agent)} says: "${ev.text}"${ints ? ` [declares ${ints}]` : ''}`;
    }
    case 'whisper':
      return `${n(ev.from)} whispers to ${n(ev.to)}: "${ev.text}"`;
    case 'proposal': {
      const alloc = Object.entries(ev.allocation)
        .map(([t, to]) => `${treasureName(state, t)} → ${n(to)}`)
        .join('; ');
      return `${n(ev.proposer)} PROPOSES: ${alloc}. Pitch: "${ev.pitch}"`;
    }
    case 'vote':
      return `${n(ev.agent)} votes ${ev.yes ? 'YES' : 'NO'}: "${ev.reason}"`;
    case 'vote_result': {
      const reasons = state.events
        .filter((e): e is Extract<GameEvent, { type: 'vote' }> => e.type === 'vote' && e.round === ev.round)
        .map((e) => `${n(e.agent)} ${e.yes ? 'YES' : 'NO'}${e.reason ? ` ("${e.reason}")` : ''}`)
        .join('; ');
      return `VOTE ${ev.passed ? 'PASSED' : 'FAILED'} ${ev.yes.length}-${ev.no.length}: ${reasons}`;
    }
    case 'transfer':
      return null; // implied by a passed vote
    case 'rot':
      return ev.reason === 'final'
        ? `${treasureName(state, ev.treasure)} rots as the game ends.`
        : `The failed vote made ${treasureName(state, ev.treasure)} ROT. It is gone.`;
    case 'game_ended':
      return `GAME OVER. Winner${ev.winners.length > 1 ? 's' : ''}: ${ev.winners.map((w) => n(w)).join(', ')}.`;
    case 'notes':
      return null;
  }
}

/** Index of the last event this agent authored (notes, say, whisper, proposal, or vote). */
function lastOwnEventIndex(state: GameState, agent: AgentId): number {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const ev = state.events[i];
    if (!ev) continue;
    const author =
      ev.type === 'notes' || ev.type === 'say' || ev.type === 'vote'
        ? ev.agent
        : ev.type === 'whisper'
          ? ev.from
          : ev.type === 'proposal'
            ? ev.proposer
            : null;
    if (author === agent) return i;
  }
  return -1;
}

export function name(state: GameState, id: AgentId): string {
  return state.agents.find((a) => a.id === id)?.name ?? id;
}

export function treasureName(state: GameState, id: TreasureId): string {
  return state.treasures.find((t) => t.id === id)?.name ?? id;
}

function treasureLabel(state: GameState, id: TreasureId): string {
  const t = state.treasures.find((x) => x.id === id);
  return t ? `${t.name} (${t.id})` : id;
}
