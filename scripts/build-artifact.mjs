// Packages the built viewer into one self-contained HTML fragment for a claude.ai artifact.
// The artifact host wraps it in its own document skeleton, so this emits <title>, <style>,
// the page markup, an embedded data snapshot, and one inline module script.
// Run after `npm run build`. The snapshot lets the page render with no network at all;
// the GitHub connector, when the viewer allows it, refreshes on demand.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_GAMES = 40;
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = resolve(root, 'dist');
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');

const asset = (href) => readFileSync(resolve(dist, `.${href.replace(/^\/bad-game/, '')}`), 'utf8');
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => asset(m[1])).join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => asset(m[1])).join('\n');

const body = (/<body>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '').replace(/<script[^>]*><\/script>/g, '');
if (!/id="app"/.test(body)) throw new Error('artifact body is missing the app root');

const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const index = read(resolve(root, 'games/index.json')) ?? [];
const leaderboard = read(resolve(root, 'data/leaderboard.json')) ?? { updatedAt: '', games: 0, standings: [] };
const liveIds = index.filter((g) => g.mode === 'live').slice(0, MAX_GAMES).map((g) => g.id);
const games = {};
for (const id of liveIds) {
  const file = resolve(root, 'games', `${id}.json`);
  if (readdirSync(resolve(root, 'games')).includes(`${id}.json`)) games[id] = read(file);
}
const snapshot = { takenAt: new Date().toISOString(), index: index.filter((g) => g.mode === 'live'), leaderboard, games };
// A JSON text node inside <script> must not contain a closing tag or U+2028/2029.
const safe = (s) => s.split('</').join('<\\/').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');

const out = `<title>The Table</title>
<style>
${css}
</style>
${body.trim()}
<script type="application/json" id="snapshot">${safe(JSON.stringify(snapshot))}</script>
<script type="module">
${safe(js)}
</script>
`;
writeFileSync(resolve(dist, 'artifact.html'), out);
console.log(`wrote dist/artifact.html (${(out.length / 1024).toFixed(1)} kB, ${liveIds.length} games embedded)`);
