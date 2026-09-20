import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgentDefinition {
  id: string;
  name: string;
  model: string;
  author: string;
  tagline: string;
  /** Persona and strategy prompt (markdown body). */
  persona: string;
  file: string;
}

const REQUIRED = ['id', 'name', 'model'] as const;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Parse an agent definition file: YAML-ish frontmatter (flat key: value) plus a markdown body. */
export function parseAgentFile(text: string, file: string): AgentDefinition {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: missing frontmatter block`);
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) throw new Error(`${file}: bad frontmatter line "${line}"`);
    meta[line.slice(0, idx).trim()] = stripQuotes(line.slice(idx + 1).trim());
  }
  for (const key of REQUIRED) {
    if (!meta[key]) throw new Error(`${file}: frontmatter is missing "${key}"`);
  }
  const id = meta['id'] as string;
  if (!ID_PATTERN.test(id)) throw new Error(`${file}: id "${id}" must match ${ID_PATTERN}`);
  const persona = (m[2] ?? '').trim();
  if (persona.length < 40) throw new Error(`${file}: persona body is too short to be useful`);
  return {
    id,
    name: meta['name'] as string,
    model: meta['model'] as string,
    author: meta['author'] ?? 'unknown',
    tagline: meta['tagline'] ?? '',
    persona,
    file,
  };
}

export function loadAgents(dir: string): Map<string, AgentDefinition> {
  const out = new Map<string, AgentDefinition>();
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.md') || entry.toUpperCase() === 'README.MD') continue;
    const file = join(dir, entry);
    const def = parseAgentFile(readFileSync(file, 'utf8'), file);
    if (out.has(def.id)) throw new Error(`duplicate agent id "${def.id}" in ${file} and ${out.get(def.id)?.file}`);
    if (entry !== `${def.id}.md`) throw new Error(`${file}: file name must be ${def.id}.md`);
    out.set(def.id, def);
  }
  return out;
}

function stripQuotes(v: string): string {
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
}
