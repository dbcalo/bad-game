import { createRng, hashSeed } from '../engine/rng.js';
import type { AgentAction, AgentId, GameState, Interest, TreasureId } from '../engine/types.js';

/**
 * A deterministic heuristic player used for tests, simulations, and as a
 * baseline. "liar" bots misdeclare their interests; "honest" bots do not.
 * It is intentionally simple: the interesting players are language models.
 */
export type ScriptedStyle = 'honest' | 'liar';

export function scriptedAction(state: GameState, agent: AgentId, style: ScriptedStyle): AgentAction {
  const card = state.cards[agent];
  if (!card) throw new Error(`no card for ${agent}`);
  const rng = createRng(hashSeed(`${state.seed}:${agent}:${state.events.length}`));
  const value = (t: TreasureId) => card.values[t] ?? 0;
  const onTable = [...state.table].sort((a, b) => value(b) - value(a));
  const best = onTable[0];
  const poison = state.table.find((t) => value(t) < 0);
  const others = state.agents.filter((a) => a.id !== agent).map((a) => a.id);

  switch (state.phase) {
    case 'discussion': {
      const interests: Record<TreasureId, Interest> = {};
      for (const t of onTable) {
        const v = value(t);
        const honest: Interest = v >= 5 ? 'want' : v <= 0 ? 'avoid' : 'meh';
        interests[t] = style === 'liar' && v >= 5 ? 'meh' : style === 'liar' && v <= 0 ? 'want' : honest;
      }
      const say =
        style === 'liar'
          ? `I'm easy. Honestly nothing here excites me much, but I'll back a fair split.`
          : `I'd like ${best ? nameOf(state, best) : 'anything'}. Give me that and I'll vote yes all game.`;
      return { notes: `Style=${style}. Best on table: ${best ?? 'none'} (${best ? value(best) : 0}).`, say, interests };
    }
    case 'whispers': {
      const proposer = state.current.proposer;
      const whispers =
        proposer !== agent && best
          ? [{ to: proposer, text: `Put ${nameOf(state, best)} on my side of the table and you have my vote.` }]
          : [];
      return { notes: `Whispering to proposer ${proposer}.`, whispers };
    }
    case 'proposal': {
      const allocation: Record<TreasureId, AgentId> = {};
      const mine = onTable.filter((t) => value(t) > 0).slice(0, 2);
      for (const t of mine) allocation[t] = agent;
      const rest = onTable.filter((t) => !mine.includes(t) && t !== poison);
      const wants = declaredWants(state);
      const shuffled = rng.shuffle(others);
      for (const other of shuffled) {
        const liked = rest.find((t) => wants[other]?.includes(t) && !(t in allocation));
        const fallback = rest.find((t) => !(t in allocation));
        const give = liked ?? fallback;
        if (give) allocation[give] = other;
      }
      if (Object.keys(allocation).length === 0 && onTable[0]) allocation[onTable[0]] = agent;
      return {
        notes: `Taking ${mine.join(',')} for myself; spreading the rest.`,
        allocation,
        pitch: 'Everyone gets something. Rejecting this just rots the pile.',
      };
    }
    case 'vote': {
      const proposal = state.current.proposal;
      const net = proposal
        ? Object.entries(proposal.allocation).reduce((s, [t, to]) => (to === agent ? s + value(t) : s), 0)
        : 0;
      const late = state.current.round >= state.config.rounds - 1;
      const yes = proposal?.proposer === agent || net > 0 || (net === 0 && late);
      return {
        notes: `Net value to me: ${net}. Late=${late}.`,
        vote: yes ? 'yes' : 'no',
        reason: yes ? 'Works for me.' : 'I get nothing out of this.',
      };
    }
    case 'ended':
      throw new Error('game over');
  }
}

function declaredWants(state: GameState): Record<AgentId, TreasureId[]> {
  const out: Record<AgentId, TreasureId[]> = {};
  for (const ev of state.events) {
    if (ev.type !== 'say') continue;
    for (const [t, i] of Object.entries(ev.interests)) {
      if (i === 'want') (out[ev.agent] ??= []).push(t);
    }
  }
  return out;
}

function nameOf(state: GameState, t: TreasureId): string {
  return state.treasures.find((x) => x.id === t)?.name ?? t;
}
