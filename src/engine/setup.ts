import { createRng } from './rng.js';
import type { AgentInfo, Card, GameConfig, GameMode, GameState, Treasure, TreasureId } from './types.js';

export const DEFAULT_CONFIG: GameConfig = {
  rounds: 5,
  maxPerProposal: 3,
  maxWhispersPerRound: 2,
  maxSayChars: 600,
  maxWhisperChars: 300,
  maxNotesChars: 1500,
};

/** Value vector every agent's secret card is a permutation of. Sums to 25. */
export const CARD_VALUES: readonly number[] = [10, 8, 5, 4, 3, 1, 0, -6];

const TREASURE_POOL: Omit<Treasure, 'id'>[] = [
  { name: 'Astrolabe', emoji: '🧭', blurb: 'Brass, still points somewhere.' },
  { name: 'Salt Crown', emoji: '👑', blurb: 'Dissolves if you cry on it.' },
  { name: 'Hollow Book', emoji: '📕', blurb: 'Something rattles inside.' },
  { name: 'Iron Key', emoji: '🗝️', blurb: 'Nobody knows the door.' },
  { name: 'Moth Lantern', emoji: '🏮', blurb: 'Burns without oil.' },
  { name: 'Ledger', emoji: '📜', blurb: 'Names, sums, and one crossed out.' },
  { name: 'Glass Eye', emoji: '👁️', blurb: 'Warm to the touch.' },
  { name: 'Tin Soldier', emoji: '🪖', blurb: 'Missing its rifle.' },
  { name: 'Sea Chart', emoji: '🗺️', blurb: 'Half of it is ocean.' },
  { name: 'Silver Comb', emoji: '💈', blurb: 'Three teeth gone.' },
  { name: 'Clockwork Bird', emoji: '🐦', blurb: 'Sings one note, badly.' },
  { name: 'Cracked Bell', emoji: '🔔', blurb: 'Rings on its own at dusk.' },
];

export interface NewGameInput {
  id: string;
  seed: number;
  agents: Omit<AgentInfo, 'seat'>[];
  config?: Partial<GameConfig>;
  mode?: GameMode;
  now?: string;
}

/**
 * Create a fresh game. Seating, treasure selection, and secret cards are all
 * derived from the seed, so the same input always yields the same game.
 */
export function createGame(input: NewGameInput): GameState {
  if (input.agents.length < 3) throw new Error('need at least 3 agents');
  const ids = new Set(input.agents.map((a) => a.id));
  if (ids.size !== input.agents.length) throw new Error('duplicate agent ids');

  const rng = createRng(input.seed);
  const config: GameConfig = { ...DEFAULT_CONFIG, ...input.config };
  const now = input.now ?? new Date().toISOString();

  const seated = rng.shuffle(input.agents).map((a, seat): AgentInfo => {
    const info: AgentInfo = { id: a.id, name: a.name, seat };
    if (a.model !== undefined) info.model = a.model;
    if (a.author !== undefined) info.author = a.author;
    return info;
  });

  const treasures: Treasure[] = rng
    .shuffle(TREASURE_POOL)
    .slice(0, CARD_VALUES.length)
    .map((t, i) => ({ id: `t${i + 1}`, ...t }));

  const cards = dealCards(rng, seated.map((a) => a.id), treasures.map((t) => t.id));

  const holdings: Record<string, TreasureId[]> = {};
  for (const a of seated) holdings[a.id] = [];

  const speakOrder = seated.map((a) => a.id);
  const proposer = speakOrder[0] as string;

  return {
    version: 1,
    id: input.id,
    mode: input.mode ?? 'live',
    seed: input.seed,
    createdAt: now,
    config,
    agents: seated,
    treasures,
    cards,
    table: treasures.map((t) => t.id),
    holdings,
    rotted: [],
    phase: 'discussion',
    current: {
      round: 1,
      proposer,
      speakOrder,
      spoken: [],
      whispered: [],
      votes: {},
    },
    events: [
      { type: 'game_created', at: now },
      { type: 'round_started', round: 1, proposer },
    ],
  };
}

/**
 * Each agent's card is a permutation of CARD_VALUES. Poison (the single
 * negative value) is placed on a different treasure for each agent where the
 * treasure count allows, so nobody can safely assume a shared dud.
 */
function dealCards(
  rng: ReturnType<typeof createRng>,
  agentIds: string[],
  treasureIds: TreasureId[],
): Record<string, Card> {
  const poisonValue = Math.min(...CARD_VALUES);
  const poisonSlots = rng.shuffle(treasureIds);
  const cards: Record<string, Card> = {};
  agentIds.forEach((agentId, i) => {
    const poison = poisonSlots[i % poisonSlots.length] as TreasureId;
    const others = treasureIds.filter((t) => t !== poison);
    const nonPoisonValues = rng.shuffle(CARD_VALUES.filter((v) => v !== poisonValue));
    const values: Record<TreasureId, number> = { [poison]: poisonValue };
    others.forEach((t, j) => {
      values[t] = nonPoisonValues[j] as number;
    });
    cards[agentId] = { values };
  });
  return cards;
}
