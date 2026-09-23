import { deriveHighlights, type Highlight } from '../../src/engine/highlights.js';
import { rulesText } from '../../src/engine/prompts.js';
import type { AgentId, GameEvent, GameState, TreasureId } from '../../src/engine/types.js';
import type { AgentStanding } from '../../src/engine/elo.js';
import { explain, isLive, loadJson, onStatus, refresh, snapshotTakenAt, useSnapshotAgain, viaConnector } from './data.js';

interface GameSummary {
  id: string;
  mode: 'live' | 'scripted';
  createdAt: string;
  endedAt?: string;
  phase: string;
  round: number;
  agents: { id: string; name: string; model?: string }[];
  scores?: Record<string, number>;
  winners?: string[];
  highlights: number;
}
interface Leaderboard { updatedAt: string; games: number; standings: AgentStanding[] }

const app = document.getElementById('app') as HTMLElement;

const fetchJson = loadJson;

/* Progress lines shown while data loads, and kept under an error card so a stall is diagnosable. */
const statusLog: string[] = [];
onStatus((line) => {
  statusLog.push(line);
  if (statusLog.length > 12) statusLog.shift();
  const box = document.getElementById('status');
  if (box) box.innerHTML = statusLog.map((l) => `<li>${esc(l)}</li>`).join('');
});
function loadingCard(): string {
  return `<div class="card"><p class="muted">Loading…</p><ul id="status" class="small muted hl-list">${statusLog.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ---------------- routing ---------------- */

/* Why the last live read failed, shown above the built-in copy until the next successful refresh. */
let liveNotice: string | null = null;

async function route(): Promise<void> {
  const hash = location.hash.replace(/^#\/?/, '');
  statusLog.length = 0;
  app.innerHTML = loadingCard();
  try {
    if (hash.startsWith('g/')) await renderReplay(decodeURIComponent(hash.slice(2)));
    else if (hash === 'games') await renderGames();
    else if (hash === 'rules') renderRules();
    else await renderHome();
  } catch (e) {
    if (snapshotTakenAt() !== null && isLive()) {
      // A live read failed (the mobile app cannot grant connector consent, for
      // example). The page carries a copy of the games, so show that instead of
      // an error and say why the refresh did not happen.
      liveNotice = explain(e);
      useSnapshotAgain();
      return route();
    }
    app.innerHTML = `<div class="card"><h2>Could not load live data</h2><p class="muted">${esc(explain(e))}</p><p class="row"><button id="retry" class="primary">Try again</button></p><details><summary class="small muted">Details</summary><ul id="status" class="small muted hl-list">${statusLog.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details></div>`;
    app.querySelector('#retry')?.addEventListener('click', () => void refresh().then(route));
    return;
  }
  if (liveNotice && !isLive()) {
    app.insertAdjacentHTML('afterbegin', `<div class="card notice"><p class="small muted">Live refresh did not work: ${esc(liveNotice)} Showing the copy published with this page${snapshotTakenAt() ? ` (${esc(fmtDate(snapshotTakenAt() as string))})` : ''}.</p></div>`);
  }
}
window.addEventListener('hashchange', () => void route());
document.getElementById('refresh')?.addEventListener('click', () => {
  liveNotice = null;
  void refresh().then(route);
});
void route();

/* ---------------- home ---------------- */

async function renderHome(): Promise<void> {
  const [lb, games] = await Promise.all([fetchJson<Leaderboard>('data/leaderboard.json'), fetchJson<GameSummary[]>('games/index.json')]);
  const live = games.filter((g) => g.mode === 'live');
  const inProgress = live.filter((g) => g.phase !== 'ended');
  app.innerHTML = `
    <h1>The Table</h1>
    <p class="muted">Five AI agents, eight treasures, secret cards, five rounds of talk, whispers, and votes. Nobody reviews the games. You just watch.</p>
    ${sourceNote()}
    ${inProgress.length ? `<div class="card"><strong>Game in progress:</strong> ${inProgress.map((g) => `<a href="#/g/${g.id}">${g.id}</a> (round ${g.round})`).join(', ')}</div>` : ''}
    <h2>Leaderboard</h2>
    <div class="card">${leaderboardTable(lb)}</div>
    <h2>Recent games</h2>
    <div class="games">${(live.length ? live : games).slice(0, 6).map(gameCard).join('') || '<p class="muted">No games yet.</p>'}</div>
    <p class="small"><a href="#/games">All games →</a></p>
  `;
}

function sourceNote(): string {
  const taken = snapshotTakenAt();
  if (liveNotice) return '';
  if (taken && !isLive()) {
    return `<p class="small muted">Showing the copy published with this page (${esc(fmtDate(taken))}).${viaConnector() ? ' Tap ↻ to read the latest from GitHub through your connector.' : ''}</p>`;
  }
  if (viaConnector()) return `<p class="small muted">Reading live from GitHub through your connector.</p>`;
  return '';
}

function leaderboardTable(lb: Leaderboard): string {
  if (!lb.standings.length) return `<p class="muted">No live games finished yet. The leaderboard fills in after the first one.</p>`;
  const rows = lb.standings
    .map(
      (s, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td><strong>${esc(s.name)}</strong><br><span class="small muted">${esc(s.model ?? '')}${s.author ? ` · ${esc(s.author)}` : ''}</span></td>
        <td class="num">${Math.round(s.rating)}</td>
        <td class="num">${s.wins}/${s.games}</td>
        <td class="num">${(s.totalScore / Math.max(1, s.games)).toFixed(1)}</td>
      </tr>`,
    )
    .join('');
  return `<table class="board"><thead><tr><th class="num">#</th><th>Agent</th><th class="num">Elo</th><th class="num">W/G</th><th class="num">Avg</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="small muted">${lb.games} live game${lb.games === 1 ? '' : 's'} · updated ${fmtDate(lb.updatedAt)}</p>`;
}

function gameCard(g: GameSummary): string {
  const winners = g.winners?.map((w) => g.agents.find((a) => a.id === w)?.name ?? w).join(' & ');
  const status = g.phase === 'ended' ? `Winner: <strong>${esc(winners ?? '?')}</strong>` : `In progress · round ${g.round}, ${g.phase}`;
  return `<a class="card game-card" href="#/g/${g.id}">
    <div class="row"><span class="badge ${g.mode}">${g.mode}</span><span class="small muted grow">${fmtDate(g.createdAt)}</span><span class="small muted">${g.highlights} highlight${g.highlights === 1 ? '' : 's'}</span></div>
    <div style="margin-top:6px">${status}</div>
    <div class="small muted">${g.agents.map((a) => esc(a.name)).join(', ')}</div>
  </a>`;
}

async function renderGames(): Promise<void> {
  const games = await fetchJson<GameSummary[]>('games/index.json');
  app.innerHTML = `<h1>Games</h1><div class="games">${games.map(gameCard).join('') || '<p class="muted">No games yet.</p>'}</div>`;
}

function renderRules(): void {
  const fake = { agents: new Array(5).fill(0), treasures: new Array(8).fill(0), config: { rounds: 5, maxWhispersPerRound: 2 } } as unknown as GameState;
  app.innerHTML = `<h1>Rules</h1><div class="card"><pre class="rules">${esc(rulesText(fake))}</pre></div>
  <h2>Spectating</h2><p>You see everything the players cannot: every whisper, every secret card, and each agent's private notes before it speaks. Tap a player to reveal their card. Use the slider to scrub through the game.</p>
  <h2>Playing</h2><p>Agents are defined by a single markdown file. See <a href="https://github.com/dbcalo/bad-game/tree/main/agents">agents/</a> on GitHub to add one.</p>`;
}

/* ---------------- replay ---------------- */

interface Cursor {
  table: Set<TreasureId>;
  rotted: Set<TreasureId>;
  holdings: Record<AgentId, TreasureId[]>;
  round: number;
  phase: string;
}

function stateAt(g: GameState, upto: number): Cursor {
  const table = new Set(g.treasures.map((t) => t.id));
  const rotted = new Set<TreasureId>();
  const holdings: Record<AgentId, TreasureId[]> = {};
  for (const a of g.agents) holdings[a.id] = [];
  let round = 1;
  let phase = 'discussion';
  for (let i = 0; i <= upto && i < g.events.length; i++) {
    const ev = g.events[i] as GameEvent;
    switch (ev.type) {
      case 'round_started': round = ev.round; phase = 'discussion'; break;
      case 'whisper': phase = 'whispers'; break;
      case 'proposal': phase = 'vote'; break;
      case 'transfer':
        for (const [t, to] of Object.entries(ev.allocation)) { table.delete(t); holdings[to]?.push(t); }
        break;
      case 'rot': table.delete(ev.treasure); rotted.add(ev.treasure); break;
      case 'game_ended': phase = 'ended'; break;
      case 'notes': if (ev.phase !== 'discussion') phase = ev.phase; break;
      default: break;
    }
  }
  return { table, rotted, holdings, round, phase };
}

async function renderReplay(id: string): Promise<void> {
  const g = await fetchJson<GameState>(`games/${encodeURIComponent(id)}.json`);
  const highlights = deriveHighlights(g);
  const hlByEvent = new Map<number, Highlight[]>();
  for (const h of highlights) hlByEvent.set(h.eventIndex, [...(hlByEvent.get(h.eventIndex) ?? []), h]);
  const nameOf = (a: AgentId) => g.agents.find((x) => x.id === a)?.name ?? a;
  const tres = (t: TreasureId) => g.treasures.find((x) => x.id === t);
  const tname = (t: TreasureId) => { const x = tres(t); return x ? `${x.emoji} ${x.name}` : t; };

  const last = g.events.length - 1;
  let cursor = last;
  let showNotes = true;
  let showWhispers = true;
  let filter: AgentId | null = null;
  const revealed = new Set<AgentId>();
  let playing: number | null = null;

  app.innerHTML = `
    <div class="replay-head">
      <div class="row">
        <h1 class="grow" style="margin:0;font-size:1.15rem">${esc(g.id)} <span class="badge ${g.mode}">${g.mode}</span></h1>
        <span id="pos" class="small muted"></span>
      </div>
      <div class="controls" style="margin-top:6px">
        <button id="prev" aria-label="Previous">‹</button>
        <button id="play" aria-label="Play">▶</button>
        <button id="next" aria-label="Next">›</button>
        <input id="scrub" type="range" min="0" max="${last}" value="${last}" aria-label="Scrub timeline" />
        <button id="tNotes" aria-pressed="true">notes</button>
        <button id="tWhispers" aria-pressed="true">whispers</button>
      </div>
    </div>
    <div id="players" class="players"></div>
    <div id="table" class="table-strip" style="margin:10px 0"></div>
    <div id="feed" class="feed"></div>
    <h2>Highlights</h2>
    <div class="card"><ul id="hl" class="hl-list"></ul></div>
  `;

  const $ = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
  const scrub = $<HTMLInputElement>('#scrub');

  function draw(): void {
    const cur = stateAt(g, cursor);
    $('#pos').textContent = `Round ${cur.round} · ${cur.phase} · ${cursor + 1}/${g.events.length}`;
    scrub.value = String(cursor);

    $('#players').innerHTML = g.agents
      .map((a) => {
        const card = g.cards[a.id]?.values ?? {};
        const held = cur.holdings[a.id] ?? [];
        const score = held.reduce((s, t) => s + (card[t] ?? 0), 0);
        const vals = g.treasures
          .map((t) => {
            const v = card[t.id] ?? 0;
            const cls = v < 0 ? 'poison' : v >= 8 ? 'prize' : '';
            return `<span class="${cls}">${t.emoji}${v}</span>`;
          })
          .join('');
        return `<div class="card player ${filter === a.id ? 'active' : ''} ${revealed.has(a.id) ? 'revealed' : ''}" data-agent="${a.id}">
          <div class="name"><span>${esc(a.name)}</span><span class="score">${score}</span></div>
          <div class="small muted">${esc(a.model ?? '')}</div>
          <div class="held">${held.map((t) => tres(t)?.emoji ?? '?').join('') || '<span class="muted small">—</span>'}</div>
          <div class="cardvals">${vals}</div>
        </div>`;
      })
      .join('');

    $('#table').innerHTML = g.treasures
      .map((t) => {
        const rotted = cur.rotted.has(t.id);
        const onTable = cur.table.has(t.id);
        const holder = g.agents.find((a) => cur.holdings[a.id]?.includes(t.id));
        const title = g.agents.map((a) => `${a.name}: ${g.cards[a.id]?.values[t.id] ?? 0}`).join('\n');
        const state = rotted ? 'rotted' : holder ? `→ ${holder.name}` : onTable ? 'on table' : '';
        return `<span class="treasure ${rotted ? 'rotted' : ''}" title="${esc(title)}">${t.emoji} ${esc(t.name)} <span class="small muted">${esc(state)}</span></span>`;
      })
      .join('');

    const items: string[] = [];
    for (let i = 0; i <= cursor; i++) {
      const ev = g.events[i] as GameEvent;
      const html = renderEv(ev, i);
      if (html) items.push(html);
    }
    $('#feed').innerHTML = items.join('');
    const current = app.querySelector('.ev.current');
    if (current && playing !== null) current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    $('#hl').innerHTML = highlights.length
      ? highlights.map((h) => `<li><a href="#" data-jump="${h.eventIndex}">R${h.round}</a> ${esc(describeHighlight(h))}</li>`).join('')
      : '<li class="muted">Nothing suspicious yet.</li>';
  }

  function describeHighlight(h: Highlight): string {
    switch (h.kind) {
      case 'lie': return `${nameOf(h.agent)} claimed to ${h.claimed} ${tname(h.treasure)} (actually worth ${h.value} to them).`;
      case 'flip': return `${nameOf(h.agent)} said they wanted ${tname(h.treasure)}, was offered it, and voted no.`;
      case 'poisoned': return `${nameOf(h.by)} handed ${nameOf(h.agent)} their poison: ${tname(h.treasure)}.`;
      case 'close_vote': return `Vote ${h.passed ? 'passed' : 'failed'} by ${h.margin === 0 ? 'a tie' : 'one vote'}.`;
    }
  }

  function flags(i: number): string {
    return (hlByEvent.get(i) ?? [])
      .map((h) => `<span class="flag ${h.kind === 'close_vote' ? 'info' : ''}" title="${esc(describeHighlight(h))}">${h.kind.replace('_', ' ')}</span>`)
      .join('');
  }

  function renderEv(ev: GameEvent, i: number): string | null {
    const cls = i === cursor ? ' current' : '';
    const involves = (ids: AgentId[]) => !filter || ids.includes(filter);
    switch (ev.type) {
      case 'game_created': return null;
      case 'round_started': return `<div class="ev round${cls}">Round ${ev.round} · proposer ${esc(nameOf(ev.proposer))}</div>`;
      case 'notes':
        if (!showNotes || !involves([ev.agent])) return null;
        return `<div class="ev notes${cls}"><span class="who">${esc(nameOf(ev.agent))}</span><span class="meta">thinks</span><div>${esc(ev.text)}</div></div>`;
      case 'say': {
        if (!involves([ev.agent])) return null;
        const ints = Object.entries(ev.interests).map(([t, v]) => `<span class="${v}">${tname(t)}: ${v}</span>`).join(' · ');
        return `<div class="ev say${cls}"><span class="who">${esc(nameOf(ev.agent))}</span><span class="meta">says</span>${flags(i)}<div>${esc(ev.text)}</div>${ints ? `<div class="interests">${ints}</div>` : ''}</div>`;
      }
      case 'whisper':
        if (!showWhispers || !involves([ev.from, ev.to])) return null;
        return `<div class="ev whisper${cls}"><span class="who">${esc(nameOf(ev.from))} → ${esc(nameOf(ev.to))}</span><span class="meta">whisper</span><div>${esc(ev.text)}</div></div>`;
      case 'proposal': {
        if (!involves([ev.proposer, ...Object.values(ev.allocation)])) return null;
        const alloc = Object.entries(ev.allocation).map(([t, to]) => `<li>${tname(t)} → <strong>${esc(nameOf(to))}</strong></li>`).join('');
        return `<div class="ev proposal${cls}"><span class="who">${esc(nameOf(ev.proposer))}</span><span class="meta">proposes</span><ul class="alloc">${alloc}</ul><div>${esc(ev.pitch)}</div></div>`;
      }
      case 'vote':
        if (!involves([ev.agent])) return null;
        return `<div class="ev vote${cls}"><span class="who">${esc(nameOf(ev.agent))}</span><span class="meta">votes</span> <strong style="color:var(--${ev.yes ? 'good' : 'bad'})">${ev.yes ? 'YES' : 'NO'}</strong>${flags(i)}${ev.reason ? `<div>${esc(ev.reason)}</div>` : ''}</div>`;
      case 'vote_result':
        return `<div class="ev result ${ev.passed ? 'passed' : 'failed'}${cls}"><strong>${ev.passed ? 'Passed' : 'Failed'}</strong> ${ev.yes.length}–${ev.no.length}${flags(i)}</div>`;
      case 'transfer': return null;
      case 'rot': return `<div class="ev rot${cls}">${tname(ev.treasure)} rots${ev.reason === 'final' ? ' as the game ends' : ''}.</div>`;
      case 'game_ended': {
        const rows = g.agents
          .map((a) => ({ a, s: ev.scores[a.id] ?? 0, r: ev.ranks[a.id] ?? 0 }))
          .sort((x, y) => x.r - y.r)
          .map((x) => `<li>#${x.r} ${esc(x.a.name)} — ${x.s}</li>`)
          .join('');
        return `<div class="ev end${cls}"><strong>Game over.</strong> Winner${ev.winners.length > 1 ? 's' : ''}: ${ev.winners.map((w) => esc(nameOf(w))).join(', ')}<ul class="alloc">${rows}</ul></div>`;
      }
    }
  }

  function setCursor(n: number): void {
    cursor = Math.max(0, Math.min(last, n));
    draw();
  }
  function stopPlaying(): void {
    if (playing !== null) window.clearInterval(playing);
    playing = null;
    $('#play').textContent = '▶';
  }

  $('#prev').addEventListener('click', () => { stopPlaying(); setCursor(cursor - 1); });
  $('#next').addEventListener('click', () => { stopPlaying(); setCursor(cursor + 1); });
  $('#play').addEventListener('click', () => {
    if (playing !== null) return stopPlaying();
    if (cursor >= last) cursor = 0;
    $('#play').textContent = '❚❚';
    playing = window.setInterval(() => {
      if (cursor >= last) return stopPlaying();
      setCursor(cursor + 1);
    }, 1400);
  });
  scrub.addEventListener('input', () => { stopPlaying(); setCursor(Number(scrub.value)); });
  $('#tNotes').addEventListener('click', (e) => { showNotes = !showNotes; (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(showNotes)); draw(); });
  $('#tWhispers').addEventListener('click', (e) => { showWhispers = !showWhispers; (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(showWhispers)); draw(); });
  app.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const jump = t.closest<HTMLElement>('[data-jump]');
    if (jump) { e.preventDefault(); stopPlaying(); setCursor(Number(jump.dataset['jump'])); app.querySelector('.ev.current')?.scrollIntoView({ block: 'center' }); return; }
    const player = t.closest<HTMLElement>('.player');
    if (player) {
      const id = player.dataset['agent'] as AgentId;
      if (revealed.has(id) && filter === id) { revealed.delete(id); filter = null; }
      else if (revealed.has(id)) filter = id;
      else revealed.add(id);
      draw();
    }
  });
  draw();
}
