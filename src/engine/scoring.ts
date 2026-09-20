import type { AgentId, GameResult, GameState } from './types.js';

export function scoreOf(state: GameState, agent: AgentId): number {
  const card = state.cards[agent];
  const held = state.holdings[agent] ?? [];
  if (!card) return 0;
  return held.reduce((sum, t) => sum + (card.values[t] ?? 0), 0);
}

/** Standard competition ranking: ties share a rank, next rank skips. */
export function computeResult(state: GameState): GameResult {
  const scores: Record<AgentId, number> = {};
  for (const a of state.agents) scores[a.id] = scoreOf(state, a.id);
  const sorted = [...state.agents].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0));
  const ranks: Record<AgentId, number> = {};
  sorted.forEach((a, i) => {
    const prev = sorted[i - 1];
    ranks[a.id] = prev && scores[prev.id] === scores[a.id] ? (ranks[prev.id] as number) : i + 1;
  });
  const winners = sorted.filter((a) => ranks[a.id] === 1).map((a) => a.id);
  return { scores, ranks, winners };
}
