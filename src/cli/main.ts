#!/usr/bin/env node
/**
 * bad-game CLI — the deterministic game master.
 *
 *   game new --agents a,b,c,d,e [--seed N] [--id ID]
 *   game next <id>                       who must act now (JSON)
 *   game prompt <id> <agent> [--full]    the text to send that agent
 *   game act <id> <agent> [file|-]       apply the agent's JSON reply
 *   game status <id>                     short human summary
 *   game show <id>                       spectator transcript (secrets included)
 *   game simulate --agents ... [--seed N] [--id ID]   play out with scripted bots
 *   game rebuild                         regenerate games/index.json and data/leaderboard.json
 *   game validate-agents                 check every file in agents/
 *   game roster [--size 5]               pick who plays next (fewest live games first)
 *   game fallback <id> <agent>           apply a scripted move for an agent that failed to answer
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAction, pendingActions } from '../engine/game.js';
import { deriveHighlights } from '../engine/highlights.js';
import { markSeen, renderEvent, renderPrompt } from '../engine/prompts.js';
import { createRng, hashSeed } from '../engine/rng.js';
import { scoreOf } from '../engine/scoring.js';
import { createGame } from '../engine/setup.js';
import { RuleError, type GameState } from '../engine/types.js';
import { scriptedAction, type ScriptedStyle } from '../players/scripted.js';
import { loadAgents, type AgentDefinition } from './agents.js';
import { GameStore } from './store.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const store = new GameStore(resolve(ROOT, 'games'), resolve(ROOT, 'data'));
const AGENTS_DIR = resolve(ROOT, 'agents');

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flag(args: Args, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === 'string' ? v : undefined;
}

function newGameId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${stamp}-${suffix}`;
}

function resolveAgents(args: Args): AgentDefinition[] {
  const list = flag(args, 'agents');
  if (!list) throw new Error('--agents a,b,c,d,e is required');
  const defs = loadAgents(AGENTS_DIR);
  return list.split(',').map((raw) => {
    const id = raw.trim();
    const def = defs.get(id);
    if (!def) throw new Error(`unknown agent "${id}". Known: ${[...defs.keys()].join(', ')}`);
    return def;
  });
}

function makeGame(args: Args, mode: GameState['mode'] = 'live'): GameState {
  const defs = resolveAgents(args);
  const id = flag(args, 'id') ?? newGameId();
  if (store.exists(id)) throw new Error(`game ${id} already exists`);
  const seedFlag = flag(args, 'seed');
  const seed = seedFlag !== undefined ? Number(seedFlag) : hashSeed(`${id}:${Date.now()}`);
  if (!Number.isFinite(seed)) throw new Error('--seed must be a number');
  return createGame({
    id,
    seed,
    mode,
    agents: defs.map((d) => ({ id: d.id, name: d.name, model: d.model, author: d.author })),
  });
}

/** Pull the first balanced {...} block out of a reply that may contain prose or code fences. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) throw new RuleError('Reply contained no JSON object.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {
          throw new RuleError(`Reply was not valid JSON: ${(e as Error).message}`);
        }
      }
    }
  }
  throw new RuleError('Reply contained an unterminated JSON object.');
}

function statusLine(state: GameState): string {
  const pending = pendingActions(state);
  const who = pending.map((p) => p.agent).join(', ') || '—';
  const scores = state.agents.map((a) => `${a.name}=${scoreOf(state, a.id)}`).join(' ');
  return `${state.id}: round ${state.current.round}/${state.config.rounds}, phase ${state.phase}, waiting on ${who}. table=[${state.table.join(',')}] scores: ${scores}`;
}

function cmdNew(args: Args): void {
  const state = makeGame(args);
  store.save(state);
  store.rebuild();
  console.log(state.id);
}

function cmdNext(args: Args): void {
  const state = store.load(need(args, 0, 'game id'));
  console.log(JSON.stringify({ id: state.id, round: state.current.round, phase: state.phase, pending: pendingActions(state) }, null, 2));
}

function cmdPrompt(args: Args): void {
  const state = store.load(need(args, 0, 'game id'));
  const agent = need(args, 1, 'agent id');
  const defs = loadAgents(AGENTS_DIR);
  const def = defs.get(agent);
  process.stdout.write(renderPrompt(state, agent, { persona: def?.persona ?? '', full: args.flags['full'] === true }));
  process.stdout.write('\n');
  store.save(markSeen(state, agent));
}

function cmdAct(args: Args): void {
  const state = store.load(need(args, 0, 'game id'));
  const agent = need(args, 1, 'agent id');
  const src = args.positional[2] ?? '-';
  const text = src === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(src), 'utf8');
  const action = extractJson(text);
  const next = applyAction(state, agent, action);
  store.save(next);
  store.rebuild();
  console.log(statusLine(next));
}

function cmdStatus(args: Args): void {
  console.log(statusLine(store.load(need(args, 0, 'game id'))));
}

function cmdShow(args: Args): void {
  const state = store.load(need(args, 0, 'game id'));
  console.log(`# ${state.id}  mode=${state.mode} seed=${state.seed}`);
  for (const a of state.agents) {
    const card = state.cards[a.id];
    const values = state.treasures.map((t) => `${t.name}=${card?.values[t.id]}`).join(' ');
    console.log(`${a.name} [${a.id}] ${a.model ?? ''}  card: ${values}`);
  }
  console.log('');
  for (const ev of state.events) {
    if (ev.type === 'notes') {
      console.log(`    (${state.agents.find((a) => a.id === ev.agent)?.name} thinks: ${ev.text})`);
      continue;
    }
    const line = renderEvent(state, null, ev);
    if (line) console.log(line);
  }
  const hl = deriveHighlights(state);
  if (hl.length) {
    console.log('\nHighlights:');
    for (const h of hl) console.log(`- ${JSON.stringify(h)}`);
  }
  console.log(`\n${statusLine(state)}`);
}

function cmdSimulate(args: Args): void {
  let state = makeGame(args, 'scripted');
  const styles: ScriptedStyle[] = ['honest', 'liar'];
  const styleOf = (agent: string): ScriptedStyle => styles[hashSeed(`${state.seed}:${agent}`) % styles.length] as ScriptedStyle;
  let guard = 0;
  while (state.phase !== 'ended') {
    const [p] = pendingActions(state);
    if (!p) break;
    state = applyAction(state, p.agent, scriptedAction(state, p.agent, styleOf(p.agent)));
    if (++guard > 10_000) throw new Error('simulation did not terminate');
  }
  store.save(state);
  store.rebuild();
  console.log(statusLine(state));
}

function cmdRebuild(): void {
  const { index, leaderboard } = store.rebuild();
  console.log(`indexed ${index.length} games, ${leaderboard.standings.length} agents on the leaderboard`);
}

/**
 * Choose the next table: agents with the fewest live games first, ties broken
 * by a seeded shuffle so the same day does not always pair the same players.
 */
function cmdRoster(args: Args): void {
  const size = Number(flag(args, 'size') ?? 5);
  const defs = [...loadAgents(AGENTS_DIR).values()];
  if (defs.length < size) throw new Error(`only ${defs.length} agents defined; need ${size}`);
  const lbPath = resolve(ROOT, 'data/leaderboard.json');
  const games: Record<string, number> = {};
  if (existsSync(lbPath)) {
    const lb = JSON.parse(readFileSync(lbPath, 'utf8')) as { standings?: { id: string; games: number }[] };
    for (const s of lb.standings ?? []) games[s.id] = s.games;
  }
  const rng = createRng(hashSeed(flag(args, 'seed') ?? new Date().toISOString().slice(0, 10)));
  const picked = rng
    .shuffle(defs)
    .sort((a, b) => (games[a.id] ?? 0) - (games[b.id] ?? 0))
    .slice(0, size)
    .map((d) => d.id);
  console.log(rng.shuffle(picked).join(','));
}

function cmdFallback(args: Args): void {
  const state = store.load(need(args, 0, 'game id'));
  const agent = need(args, 1, 'agent id');
  const action = scriptedAction(state, agent, 'honest');
  action.notes = `[fallback: the model did not return a valid action] ${action.notes}`;
  const next = applyAction(state, agent, action);
  store.save(next);
  store.rebuild();
  console.log(statusLine(next));
}

function cmdValidateAgents(): void {
  const defs = loadAgents(AGENTS_DIR);
  for (const d of defs.values()) console.log(`ok  ${d.id.padEnd(16)} ${d.name} (${d.model}) by ${d.author}`);
  if (defs.size < 3) throw new Error('need at least 3 agent definitions to play');
}

function need(args: Args, i: number, what: string): string {
  const v = args.positional[i];
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

const COMMANDS: Record<string, (args: Args) => void> = {
  new: cmdNew,
  next: cmdNext,
  prompt: cmdPrompt,
  act: cmdAct,
  status: cmdStatus,
  show: cmdShow,
  simulate: cmdSimulate,
  rebuild: cmdRebuild,
  'validate-agents': cmdValidateAgents,
  roster: cmdRoster,
  fallback: cmdFallback,
};

function main(): void {
  // Piping into `head` closes stdout early; that is not an error worth a stack trace.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  const [cmd, ...rest] = process.argv.slice(2);
  const run = cmd ? COMMANDS[cmd] : undefined;
  if (!run) {
    console.error(`usage: game <${Object.keys(COMMANDS).join('|')}> ...`);
    process.exit(2);
  }
  try {
    run(parseArgs(rest));
  } catch (e) {
    const err = e as Error;
    if (err instanceof RuleError) {
      console.error(`REJECTED: ${err.message}`);
      process.exit(3);
    }
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
