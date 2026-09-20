import { describe, expect, it } from 'vitest';
import { applyAction, pendingActions } from '../engine/game.js';
import { deriveHighlights } from '../engine/highlights.js';
import { markSeen, renderPrompt, visibleEvents } from '../engine/prompts.js';
import { computeResult } from '../engine/scoring.js';
import { CARD_VALUES, createGame } from '../engine/setup.js';
import { RuleError, type GameState } from '../engine/types.js';
import { updateRatings } from '../engine/elo.js';
import { scriptedAction } from '../players/scripted.js';

const AGENTS = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id.toUpperCase() }));

function fresh(seed = 42): GameState {
  return createGame({ id: 'test', seed, agents: AGENTS, now: '2026-01-01T00:00:00.000Z' });
}

function playOut(state: GameState): GameState {
  let s = state;
  let guard = 0;
  while (s.phase !== 'ended') {
    const [p] = pendingActions(s);
    if (!p) throw new Error('stuck');
    s = applyAction(s, p.agent, scriptedAction(s, p.agent, guard % 2 ? 'liar' : 'honest'), '2026-01-01T01:00:00.000Z');
    if (++guard > 5000) throw new Error('did not terminate');
  }
  return s;
}

describe('setup', () => {
  it('is deterministic for a seed', () => {
    const a = fresh(7);
    const b = fresh(7);
    expect(a).toEqual(b);
    expect(fresh(8).agents.map((x) => x.id)).not.toEqual(a.agents.map((x) => x.id));
  });

  it('deals each agent a permutation of the card values with distinct poison', () => {
    const s = fresh();
    const poisons = new Set<string>();
    for (const a of s.agents) {
      const values = Object.values(s.cards[a.id]!.values).sort((x, y) => x - y);
      expect(values).toEqual([...CARD_VALUES].sort((x, y) => x - y));
      const poison = Object.entries(s.cards[a.id]!.values).find(([, v]) => v < 0)![0];
      poisons.add(poison);
    }
    expect(poisons.size).toBe(s.agents.length);
  });

  it('rejects duplicate agents and tiny tables', () => {
    expect(() => createGame({ id: 'x', seed: 1, agents: [AGENTS[0]!, AGENTS[0]!, AGENTS[1]!] })).toThrow(/duplicate/);
    expect(() => createGame({ id: 'x', seed: 1, agents: AGENTS.slice(0, 2) })).toThrow(/at least 3/);
  });
});

describe('phases', () => {
  it('runs discussion in seat order, then simultaneous whispers, proposal, vote', () => {
    let s = fresh();
    const order = s.current.speakOrder;
    expect(pendingActions(s).map((p) => p.agent)).toEqual([order[0]]);
    expect(() => applyAction(s, order[1]!, { notes: '', say: 'hi' })).toThrow(RuleError);
    for (const id of order) s = applyAction(s, id, { notes: 'n', say: `hello from ${id}` });
    expect(s.phase).toBe('whispers');
    expect(pendingActions(s)).toHaveLength(5);
    for (const id of order) s = applyAction(s, id, { notes: 'n', whispers: [] });
    expect(s.phase).toBe('proposal');
    expect(pendingActions(s).map((p) => p.agent)).toEqual([s.current.proposer]);
  });

  it('validates whispers', () => {
    let s = fresh();
    for (const id of s.current.speakOrder) s = applyAction(s, id, { notes: '', say: 'x' });
    const me = s.agents[0]!.id;
    const other = s.agents[1]!.id;
    expect(() => applyAction(s, me, { notes: '', whispers: [{ to: me, text: 'hi' }] })).toThrow(/yourself/);
    expect(() => applyAction(s, me, { notes: '', whispers: [{ to: 'zzz', text: 'hi' }] })).toThrow(/Unknown agent/);
    expect(() => applyAction(s, me, { notes: '', whispers: [{ to: other, text: 'a' }, { to: other, text: 'b' }] })).toThrow(/one whisper per recipient/);
    expect(() =>
      applyAction(s, me, { notes: '', whispers: [{ to: other, text: 'a' }, { to: s.agents[2]!.id, text: 'b' }, { to: s.agents[3]!.id, text: 'c' }] }),
    ).toThrow(/At most 2/);
    const next = applyAction(s, me, { notes: '', whispers: [{ to: other, text: 'psst' }] });
    expect(visibleEvents(next, other).some(({ ev }) => ev.type === 'whisper')).toBe(true);
    expect(visibleEvents(next, s.agents[2]!.id).some(({ ev }) => ev.type === 'whisper')).toBe(false);
  });

  it('validates proposals and resolves votes with majority', () => {
    let s = fresh();
    for (const id of s.current.speakOrder) s = applyAction(s, id, { notes: '', say: 'x' });
    for (const id of s.current.speakOrder) s = applyAction(s, id, { notes: '', whispers: [] });
    const proposer = s.current.proposer;
    expect(() => applyAction(s, proposer, { notes: '', allocation: {}, pitch: '' })).toThrow(/at least one/);
    expect(() => applyAction(s, proposer, { notes: '', allocation: { t99: proposer }, pitch: '' })).toThrow(/not on the table/);
    expect(() => applyAction(s, proposer, { notes: '', allocation: { t1: 'nobody' }, pitch: '' })).toThrow(/Unknown recipient/);
    s = applyAction(s, proposer, { notes: '', allocation: { t1: proposer, t2: s.agents[1]!.id }, pitch: 'fair' });
    expect(s.phase).toBe('vote');
    const ids = s.agents.map((a) => a.id);
    // 2 yes, 3 no → fails, one treasure rots
    ids.forEach((id, i) => {
      s = applyAction(s, id, { notes: '', vote: i < 2 ? 'yes' : 'no', reason: 'r' });
    });
    expect(s.current.round).toBe(2);
    expect(s.rotted).toHaveLength(1);
    expect(s.table).toHaveLength(7);
    expect(s.holdings[proposer]).toEqual([]);
    expect(s.current.proposer).toBe(s.agents[1]!.id);
  });

  it('caps how many treasures one proposal may move, and honours unlimited for legacy games', () => {
    let s = fresh();
    for (const id of s.current.speakOrder) s = applyAction(s, id, { notes: '', say: 'x' });
    for (const id of s.current.speakOrder) s = applyAction(s, id, { notes: '', whispers: [] });
    const p = s.current.proposer;
    const four = { t1: p, t2: p, t3: p, t4: p };
    expect(() => applyAction(s, p, { notes: '', allocation: four, pitch: '' })).toThrow(/at most 3/);
    const legacy: GameState = { ...s, config: { ...s.config } };
    delete legacy.config.maxPerProposal;
    expect(() => applyAction(legacy, p, { notes: '', allocation: four, pitch: '' })).not.toThrow();
  });

  it('moves treasures on a passed vote', () => {
    let s = fresh();
    for (const id of s.current.speakOrder) s = applyAction(s, id, { notes: '', say: 'x' });
    for (const id of s.current.speakOrder) s = applyAction(s, id, { notes: '', whispers: [] });
    const proposer = s.current.proposer;
    s = applyAction(s, proposer, { notes: '', allocation: { t1: proposer }, pitch: '' });
    for (const a of s.agents) s = applyAction(s, a.id, { notes: '', vote: 'yes', reason: '' });
    expect(s.holdings[proposer]).toEqual(['t1']);
    expect(s.table).not.toContain('t1');
    expect(s.rotted).toEqual([]);
  });
});

describe('full games', () => {
  it('terminates and scores', () => {
    const s = playOut(fresh(3));
    expect(s.phase).toBe('ended');
    expect(s.table).toEqual([]);
    expect(s.result).toBeDefined();
    const total = s.agents.reduce((n, a) => n + s.holdings[a.id]!.length, 0) + s.rotted.length;
    expect(total).toBe(8);
    expect(pendingActions(s)).toEqual([]);
    expect(Object.values(s.result!.ranks)).toContain(1);
  });

  it('is deterministic end to end', () => {
    expect(playOut(fresh(11)).events).toEqual(playOut(fresh(11)).events);
  });

  it('derives highlights without crashing across seeds', () => {
    for (let seed = 1; seed < 20; seed++) {
      const s = playOut(fresh(seed));
      const hl = deriveHighlights(s);
      for (const h of hl) expect(h.eventIndex).toBeLessThan(s.events.length);
    }
  });
});

describe('prompts', () => {
  it('hides notes and other players whispers', () => {
    let s = fresh();
    const first = s.current.speakOrder[0]!;
    s = applyAction(s, first, { notes: 'TOP SECRET PLAN', say: 'hello' });
    const second = s.current.speakOrder[1]!;
    const prompt = renderPrompt(s, second, { persona: 'You are B.', full: true });
    expect(prompt).not.toContain('TOP SECRET PLAN');
    expect(prompt).toContain('hello');
    expect(prompt).toContain('YOUR SECRET CARD');
    expect(prompt).toContain('You are B.');
    const delta = renderPrompt(s, second, { persona: 'You are B.', full: false });
    expect(delta).not.toContain('You are B.');
    expect(delta).toContain('SINCE YOUR LAST TURN');
  });

  it('shows only events since the agent last acted in delta mode', () => {
    let s = fresh();
    const [a1, a2, a3] = s.current.speakOrder as [string, string, string];
    s = applyAction(s, a1, { notes: '', say: 'first' });
    s = applyAction(s, a2, { notes: '', say: 'second' });
    s = applyAction(s, a3, { notes: '', say: 'third' });
    const delta = renderPrompt(s, s.current.speakOrder[3]!, { persona: '', full: false });
    expect(delta).toContain('first');
    // a1 already spoke; its delta should not repeat its own line but should include later ones
    for (const id of s.current.speakOrder.slice(3)) s = applyAction(s, id, { notes: '', say: 'later' });
    const d1 = renderPrompt(s, a1, { persona: '', full: false });
    expect(d1).not.toContain('"first"');
    expect(d1).toContain('second');
  });
});

describe('seen cursor', () => {
  it('shows a whisper that arrived before my own move in the same phase', () => {
    let s = fresh();
    for (const id of s.current.speakOrder) s = applyAction(s, id, { notes: '', say: 'x' });
    const b = s.current.proposer; // will be prompted again for the proposal
    const a = s.agents.map((x) => x.id).find((id) => id !== b) as string;
    // Both are prompted for whispers at the same moment.
    s = markSeen(markSeen(s, a), b);
    s = applyAction(s, a, { notes: '', whispers: [{ to: b, text: 'secret for b' }] });
    s = applyAction(s, b, { notes: '', whispers: [{ to: a, text: 'secret for a' }] });
    for (const id of s.agents.map((x) => x.id).filter((id) => id !== a && id !== b)) s = applyAction(s, id, { notes: '', whispers: [] });
    // b's next prompt must include a's whisper even though a acted before b did.
    const promptB = renderPrompt(s, b, { persona: '', full: false });
    expect(promptB).toContain('secret for b');
    expect(promptB).not.toContain('secret for a'); // own whisper is not repeated
    const seenA = visibleEvents(s, a, s.seen?.[a], true).map(({ ev }) => ev);
    expect(seenA.some((ev) => ev.type === 'whisper' && ev.text === 'secret for a')).toBe(true);
    expect(seenA.some((ev) => ev.type === 'whisper' && ev.text === 'secret for b')).toBe(false);
  });
});

describe('scoring and elo', () => {
  it('ranks with shared ranks on ties', () => {
    const s = fresh();
    s.holdings['a'] = ['t1'];
    s.holdings['b'] = ['t1'];
    s.cards['a']!.values['t1'] = 10;
    s.cards['b']!.values['t1'] = 10;
    const r = computeResult(s);
    expect(r.ranks['a']).toBe(1);
    expect(r.ranks['b']).toBe(1);
    expect(r.winners.sort()).toEqual(['a', 'b']);
    expect(Math.min(...['c', 'd', 'e'].map((id) => r.ranks[id]!))).toBe(3);
  });

  it('elo is zero-sum and rewards the winner', () => {
    const ratings = { a: 1000, b: 1000, c: 1000 };
    const after = updateRatings(ratings, { scores: { a: 3, b: 2, c: 1 }, ranks: { a: 1, b: 2, c: 3 }, winners: ['a'] });
    expect(after.a).toBeGreaterThan(1000);
    expect(after.c).toBeLessThan(1000);
    expect(after.a! + after.b! + after.c!).toBeCloseTo(3000, 6);
  });
});
