// Copies games/ and data/ into web/public so the static viewer can fetch them.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const out = resolve(root, 'web/public');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ['games', 'data']) {
  const src = resolve(root, dir);
  if (existsSync(src)) cpSync(src, resolve(out, dir), { recursive: true });
}
console.log(`synced games/ and data/ into ${out}`);
