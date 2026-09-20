/**
 * Where the viewer gets its JSON.
 *
 * On GitHub Pages the files sit next to the page, so plain fetch works.
 * Inside a claude.ai artifact the page cannot fetch other hosts, but it can
 * read the repository through the viewer's GitHub connector via the `mcp`
 * capability. Both paths return the same parsed JSON.
 */

const REPO = { owner: 'dbcalo', repo: 'bad-game' };
const SERVER = 'github';

interface McpLike {
  callTool(server: string, tool: string, input?: unknown, options?: unknown): Promise<{ content?: unknown; payload?: unknown }>;
  invalidate(server?: string, tool?: string, input?: unknown): Promise<void>;
}
interface ClaudeLike {
  use(name: string): Promise<unknown>;
}

export class DataError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let mcpPromise: Promise<McpLike | null> | null = null;

function claude(): ClaudeLike | undefined {
  return (window as unknown as { claude?: ClaudeLike }).claude;
}

/** Resolves the mcp namespace once, or null when this page is not framed by claude.ai. */
function mcp(): Promise<McpLike | null> {
  if (!mcpPromise) {
    const c = claude();
    mcpPromise = c && typeof c.use === 'function' ? (c.use('mcp') as Promise<McpLike | null>).catch(() => null) : Promise.resolve(null);
  }
  return mcpPromise;
}

export function viaConnector(): boolean {
  return Boolean(claude()?.use);
}

/** Pull JSON out of a get_file_contents result, whose text block starts with a short preamble. */
function parseFileResult(result: { content?: unknown; payload?: unknown }): unknown {
  if (result.payload && typeof result.payload === 'object') return result.payload;
  const texts: string[] = [];
  if (typeof result.payload === 'string') texts.push(result.payload);
  if (Array.isArray(result.content)) {
    for (const block of result.content as Record<string, unknown>[]) {
      if (typeof block['text'] === 'string') texts.push(block['text']);
      const res = block['resource'] as Record<string, unknown> | undefined;
      if (res && typeof res['text'] === 'string') texts.push(res['text']);
    }
  }
  // The text may begin with a preamble that itself contains brackets, so try
  // every '[' or '{' in order; JSON.parse only succeeds when the remainder is
  // exactly one document, which rules out a partial match inside the preamble.
  for (const text of texts) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== '[' && ch !== '{') continue;
      try {
        return JSON.parse(text.slice(i));
      } catch {
        /* try the next candidate */
      }
    }
  }
  throw new DataError('parse', 'The connector returned a file this page could not read.');
}

export async function loadJson<T>(path: string, fresh = false): Promise<T> {
  const m = await mcp();
  if (m) {
    try {
      const result = await m.callTool(
        SERVER,
        'get_file_contents',
        { ...REPO, path },
        { cache: fresh ? { staleTime: 0, refresh: true } : { staleTime: 60_000 } },
      );
      return parseFileResult(result) as T;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      throw new DataError(err.code ?? 'upstream_error', err.message ?? 'Connector call failed.');
    }
  }
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}${path}?t=${Date.now()}`);
  if (!res.ok) throw new DataError(String(res.status), `${path}: ${res.status}`);
  return (await res.json()) as T;
}

export async function refresh(): Promise<void> {
  const m = await mcp();
  if (m) await m.invalidate(SERVER, 'get_file_contents').catch(() => undefined);
}

/** Copy the viewer can act on, keyed by connector error code. */
export function explain(e: unknown): string {
  const err = e as Partial<DataError>;
  switch (err.code) {
    case 'server_not_connected':
    case 'selection_required':
      return 'This page reads the games through your GitHub connector. Add GitHub in claude.ai Settings → Connectors, then reload.';
    case 'needs_reauth':
      return 'Your GitHub connector needs to be reconnected in claude.ai Settings → Connectors.';
    case 'not_in_manifest':
      return 'GitHub access was declined for this page. Allow it when asked, or reload to be asked again.';
    case 'server_unavailable':
    case 'rate_limited':
      return 'GitHub did not answer in time. Tap Refresh to try again.';
    case '404':
      return 'That game is not published yet.';
    default:
      return err.message ?? 'Something went wrong loading the data.';
  }
}
