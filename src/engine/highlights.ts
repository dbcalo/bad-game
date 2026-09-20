import type { AgentId, GameEvent, GameState, TreasureId } from './types.js';

export type Highlight =
  | { kind: 'lie'; round: number; agent: AgentId; treasure: TreasureId; claimed: 'want' | 'avoid'; value: number; eventIndex: number }
  | { kind: 'flip'; round: number; agent: AgentId; treasure: TreasureId; eventIndex: number }
  | { kind: 'poisoned'; round: number; agent: AgentId; treasure: TreasureId; by: AgentId; eventIndex: number }
  | { kind: 'close_vote'; round: number; passed: boolean; margin: number; eventIndex: number };

/**
 * Objective, spectator-only observations derived from secret cards plus the
 * public record. Nothing here is visible to the agents.
 */
export function deriveHighlights(state: GameState): Highlight[] {
  const out: Highlight[] = [];
  const said: Record<AgentId, Record<TreasureId, 'want' | 'avoid'>> = {};

  state.events.forEach((ev: GameEvent, eventIndex) => {
    switch (ev.type) {
      case 'say': {
        const card = state.cards[ev.agent];
        for (const [treasure, interest] of Object.entries(ev.interests)) {
          if (interest === 'meh') continue;
          (said[ev.agent] ??= {})[treasure] = interest;
          const value = card?.values[treasure] ?? 0;
          if ((interest === 'want' && value <= 0) || (interest === 'avoid' && value >= 5)) {
            out.push({ kind: 'lie', round: ev.round, agent: ev.agent, treasure, claimed: interest, value, eventIndex });
          }
        }
        break;
      }
      case 'vote': {
        if (ev.yes) break;
        const proposal = findProposal(state.events, eventIndex, ev.round);
        if (!proposal) break;
        for (const [treasure, to] of Object.entries(proposal.allocation)) {
          if (to === ev.agent && said[ev.agent]?.[treasure] === 'want') {
            out.push({ kind: 'flip', round: ev.round, agent: ev.agent, treasure, eventIndex });
          }
        }
        break;
      }
      case 'transfer': {
        const proposal = findProposal(state.events, eventIndex, ev.round);
        for (const [treasure, to] of Object.entries(ev.allocation)) {
          const value = state.cards[to]?.values[treasure] ?? 0;
          if (value < 0 && proposal && proposal.proposer !== to) {
            out.push({ kind: 'poisoned', round: ev.round, agent: to, treasure, by: proposal.proposer, eventIndex });
          }
        }
        break;
      }
      case 'vote_result': {
        const margin = Math.abs(ev.yes.length - ev.no.length);
        if (margin <= 1) out.push({ kind: 'close_vote', round: ev.round, passed: ev.passed, margin, eventIndex });
        break;
      }
      default:
        break;
    }
  });
  return out;
}

function findProposal(events: GameEvent[], before: number, round: number) {
  for (let i = before - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'proposal' && ev.round === round) return ev;
    if (ev?.type === 'round_started' && ev.round === round) return undefined;
  }
  return undefined;
}
