import type { AgentId, GameResult } from './types.js';

export const ELO_START = 1000;
export const ELO_K = 24;

export interface AgentStanding {
  id: AgentId;
  name: string;
  rating: number;
  games: number;
  wins: number;
  totalScore: number;
  totalRank: number;
  lastPlayed?: string;
  model?: string;
  author?: string;
}

/**
 * Multiplayer Elo: every pair of players in a game is treated as one
 * head-to-head match decided by final rank. Ratings update simultaneously
 * from the pre-game snapshot, so seat order does not matter.
 */
export function updateRatings(
  ratings: Record<AgentId, number>,
  result: GameResult,
  k = ELO_K,
): Record<AgentId, number> {
  const ids = Object.keys(result.ranks);
  const before: Record<AgentId, number> = {};
  for (const id of ids) before[id] = ratings[id] ?? ELO_START;
  const after: Record<AgentId, number> = { ...before };
  const pairs = ids.length - 1;
  for (const a of ids) {
    let delta = 0;
    for (const b of ids) {
      if (a === b) continue;
      const expected = 1 / (1 + 10 ** (((before[b] as number) - (before[a] as number)) / 400));
      const ra = result.ranks[a] as number;
      const rb = result.ranks[b] as number;
      const actual = ra < rb ? 1 : ra > rb ? 0 : 0.5;
      delta += (k / pairs) * (actual - expected);
    }
    after[a] = (before[a] as number) + delta;
  }
  return after;
}
