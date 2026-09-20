// Packages the built viewer into one self-contained HTML fragment for a claude.ai artifact.
// The artifact host wraps it in its own document skeleton, so this emits <title>, <style>,
// the page markup, and one inline module script. Run after `npm run build`.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = resolve(root, 'dist');
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');

const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)]
  .map((m) => readFileSync(resolve(dist, `.${m[1].replace(/^\/bad-game/, '')}`), 'utf8'))
  .join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)]
  .map((m) => readFileSync(resolve(dist, `.${m[1].replace(/^\/bad-game/, '')}`), 'utf8'))
  .join('\n')
  .replace(/<\/script/g, '<\\/script');

const body = (/<body>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '').replace(/<script[^>]*><\/script>/g, '');
if (!/id="app"/.test(body)) throw new Error('artifact body is missing the app root');
const out = `<title>The Table</title>
<style>
${css}
</style>
${body.trim()}
<script type="module">
${js}
</script>
`;
writeFileSync(resolve(dist, 'artifact.html'), out);
console.log(`wrote dist/artifact.html (${(out.length / 1024).toFixed(1)} kB)`);
