import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveHighlights } from '../engine/highlights.js';
import { ELO_START, updateRatings, type AgentStanding } from '../engine/elo.js';
import type { AgentId, GameState } from '../engine/types.js';

export interface GameSummary {
  id: string;
  mode: GameState['mode'];
  seed: number;
  createdAt: string;
  endedAt?: string;
  phase: GameState['phase'];
  round: number;
  agents: { id: AgentId; name: string; model?: string }[];
  scores?: Record<AgentId, number>;
  winners?: AgentId[];
  highlights: number;
  events: number;
}

export interface Leaderboard {
  updatedAt: string;
  games: number;
  standings: AgentStanding[];
}

export class GameStore {
  constructor(
    readonly gamesDir: string,
    readonly dataDir: string,
  ) {}

  path(id: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid game id "${id}"`);
    return join(this.gamesDir, `${id}.json`);
  }

  exists(id: string): boolean {
    return existsSync(this.path(id));
  }

  load(id: string): GameState {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`no such game: ${id}`);
    return JSON.parse(readFileSync(p, 'utf8')) as GameState;
  }

  /** Atomic write: temp file then rename, so a crash never leaves a half-written game. */
  save(state: GameState): void {
    mkdirSync(this.gamesDir, { recursive: true });
    const p = this.path(state.id);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, p);
  }

  listIds(): string[] {
    if (!existsSync(this.gamesDir)) return [];
    return readdirSync(this.gamesDir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  }

  summarize(state: GameState): GameSummary {
    const s: GameSummary = {
      id: state.id,
      mode: state.mode,
      seed: state.seed,
      createdAt: state.createdAt,
      phase: state.phase,
      round: state.current.round,
      agents: state.agents.map((a) => (a.model ? { id: a.id, name: a.name, model: a.model } : { id: a.id, name: a.name })),
      highlights: deriveHighlights(state).length,
      events: state.events.length,
    };
    if (state.endedAt) s.endedAt = state.endedAt;
    if (state.result) {
      s.scores = state.result.scores;
      s.winners = state.result.winners;
    }
    return s;
  }

  /** Recompute games/index.json and data/leaderboard.json from every game on disk. */
  rebuild(): { index: GameSummary[]; leaderboard: Leaderboard } {
    const states = this.listIds().map((id) => this.load(id));
    const index = states
      .map((s) => this.summarize(s))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    const finished = states
      .filter((s) => s.mode === 'live' && s.result && s.endedAt)
      .sort((a, b) => ((a.endedAt as string) < (b.endedAt as string) ? -1 : 1));

    const standings = new Map<AgentId, AgentStanding>();
    let ratings: Record<AgentId, number> = {};
    for (const g of finished) {
      const result = g.result as NonNullable<GameState['result']>;
      for (const a of g.agents) {
        const st = standings.get(a.id) ?? {
          id: a.id,
          name: a.name,
          rating: ELO_START,
          games: 0,
          wins: 0,
          totalScore: 0,
          totalRank: 0,
        };
        st.name = a.name;
        if (a.model) st.model = a.model;
        if (a.author) st.author = a.author;
        st.games += 1;
        st.wins += result.winners.includes(a.id) ? 1 : 0;
        st.totalScore += result.scores[a.id] ?? 0;
        st.totalRank += result.ranks[a.id] ?? g.agents.length;
        st.lastPlayed = g.endedAt as string;
        standings.set(a.id, st);
      }
      ratings = { ...ratings, ...updateRatings(ratings, result) };
    }
    for (const [id, st] of standings) st.rating = Math.round((ratings[id] ?? ELO_START) * 10) / 10;

    // Derived from the games themselves so rebuilds are reproducible and CI can diff them.
    const updatedAt = states.reduce((m, s) => {
      const t = s.endedAt ?? s.createdAt;
      return t > m ? t : m;
    }, '1970-01-01T00:00:00.000Z');
    const leaderboard: Leaderboard = {
      updatedAt,
      games: finished.length,
      standings: [...standings.values()].sort((a, b) => b.rating - a.rating || b.wins - a.wins),
    };

    mkdirSync(this.gamesDir, { recursive: true });
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(join(this.gamesDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    writeFileSync(join(this.dataDir, 'leaderboard.json'), `${JSON.stringify(leaderboard, null, 2)}\n`);
    return { index, leaderboard };
  }
}
