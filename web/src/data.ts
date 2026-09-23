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
  listTools(server?: string): Promise<{ servers: { server: string; authStatus: string; tools: { name: string }[] }[] }>;
}

/** Progress lines for the loading card, so a stall says where it is stuck. */
type StatusListener = (line: string) => void;
let listener: StatusListener = () => undefined;
export function onStatus(fn: StatusListener): void {
  listener = fn;
}
function status(line: string): void {
  listener(line);
}

const CALL_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DataError('timeout', `${what} did not answer within ${Math.round(ms / 1000)} seconds.`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
interface PermissionsLike {
  state(name: string): Promise<string>;
  request(names?: readonly string[]): Promise<Record<string, string>>;
}
interface ClaudeLike {
  use(name: string): Promise<unknown>;
}

/* ---- embedded snapshot (artifact builds only) ---- */

interface Snapshot {
  takenAt: string;
  index: unknown[];
  leaderboard: unknown;
  games: Record<string, unknown>;
}

let snapshotCache: Snapshot | null | undefined;
function snapshot(): Snapshot | null {
  if (snapshotCache !== undefined) return snapshotCache;
  try {
    const el = document.getElementById('snapshot');
    snapshotCache = el?.textContent ? (JSON.parse(el.textContent) as Snapshot) : null;
  } catch {
    snapshotCache = null;
  }
  return snapshotCache;
}

/** When the page carries a snapshot, this is when it was taken; otherwise null. */
export function snapshotTakenAt(): string | null {
  return snapshot()?.takenAt ?? null;
}

function fromSnapshot(path: string): unknown | undefined {
  const snap = snapshot();
  if (!snap) return undefined;
  if (path === 'games/index.json') return snap.index;
  if (path === 'data/leaderboard.json') return snap.leaderboard;
  const m = /^games\/(.+)\.json$/.exec(path);
  if (m && m[1] && m[1] in snap.games) return snap.games[m[1]];
  return undefined;
}

/** Set by the refresh control: read live through the connector instead of the snapshot. */
let preferLive = false;

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
    if (c && typeof c.use === 'function') {
      status('Connecting to the claude.ai runtime…');
      mcpPromise = (c.use('mcp') as Promise<McpLike | null>)
        .then((m) => {
          status(m ? 'Runtime ready.' : 'Runtime has no connector access here; falling back to the site files.');
          return m;
        })
        .catch(() => null);
    } else {
      mcpPromise = Promise.resolve(null);
    }
  }
  return mcpPromise;
}

let checked = false;
/** One-time report of what the runtime sees for the GitHub connector. */
async function describeConnector(m: McpLike): Promise<void> {
  if (checked) return;
  checked = true;
  try {
    const { servers } = await withTimeout(m.listTools(SERVER), 10_000, 'Connector listing');
    const gh = servers.find((x) => x.server.toLowerCase() === SERVER);
    if (!gh) status('GitHub connector: not listed for this viewer.');
    else status(`GitHub connector: ${gh.authStatus}, ${gh.tools.length} tool${gh.tools.length === 1 ? '' : 's'} allowed.`);
  } catch (e) {
    status(`GitHub connector check failed: ${(e as Error).message}`);
  }
}

export function viaConnector(): boolean {
  return Boolean(claude()?.use);
}

let consentAsked = false;

/**
 * Ask the viewer to allow the GitHub connector for this page before the first
 * call, so the runtime never has to refuse a call for lack of consent. Safe to
 * call repeatedly: a decision made this page load is not re-asked.
 */
async function ensureConsent(): Promise<void> {
  const c = claude();
  if (!c?.use || consentAsked) return;
  consentAsked = true;
  try {
    const perms = (await c.use('permissions')) as PermissionsLike | null;
    if (!perms) return;
    const state = await perms.state(`mcp:${SERVER}`).catch(() => 'unavailable');
    status(`GitHub permission: ${state}.`);
    if (state === 'prompt') {
      status('Waiting for you to allow GitHub…');
      const result = await withTimeout(perms.request([`mcp:${SERVER}`]), 90_000, 'The permission prompt').catch(() => ({}) as Record<string, string>);
      status(`GitHub permission: ${result[`mcp:${SERVER}`] ?? 'undecided'}.`);
    }
  } catch {
    /* consent stays lazy; the call itself will ask */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  if (!preferLive) {
    const hit = fromSnapshot(path);
    if (hit !== undefined) return hit as T;
  }
  const m = await mcp();
  if (m) {
    await ensureConsent();
    await describeConnector(m);
    const call = () =>
      withTimeout(
        m.callTool(
          SERVER,
          'get_file_contents',
          { ...REPO, path },
          { cache: fresh ? { staleTime: 0, refresh: true } : { staleTime: 60_000 }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
        ),
        CALL_TIMEOUT_MS + 2_000,
        `Reading ${path}`,
      );
    let attempt = 0;
    for (;;) {
      try {
        status(`Reading ${path}${attempt ? ' (retry)' : ''}…`);
        const parsed = parseFileResult(await call()) as T;
        status(`Loaded ${path}.`);
        return parsed;
      } catch (e) {
        const err = e as { code?: string; message?: string; retryable?: boolean; retryAfterMs?: number };
        status(`Reading ${path} failed: ${err.code ?? 'error'} — ${err.message ?? ''}`);
        // The runtime marks a call retryable when, for example, consent could
        // not be asked at that instant. One retry after its suggested delay.
        if (err.retryable && attempt === 0) {
          attempt = 1;
          await sleep(Math.min(err.retryAfterMs ?? 1500, 10_000) + Math.random() * 500);
          continue;
        }
        throw new DataError(err.code ?? 'upstream_error', err.message ?? 'Connector call failed.');
      }
    }
  }
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}${path}?t=${Date.now()}`);
  if (!res.ok) throw new DataError(String(res.status), `${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Read live on the next load. Falls back to the snapshot again if the live read fails. */
export async function refresh(): Promise<void> {
  preferLive = true;
  const m = await mcp();
  if (m) await m.invalidate(SERVER, 'get_file_contents').catch(() => undefined);
}

export function useSnapshotAgain(): void {
  preferLive = false;
}

export function isLive(): boolean {
  return preferLive || !snapshot();
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
    case 'consent_required':
      return 'GitHub access was declined for this page. Allow it when asked, or reload to be asked again.';
    case 'upstream_error':
      return 'GitHub access for this page could not be confirmed. The Claude mobile app cannot allow a connector from an artifact; open this link in a browser at claude.ai to refresh.';
    case 'server_unavailable':
    case 'rate_limited':
    case 'timeout':
    case 'cancelled':
      return 'GitHub did not answer in time. Tap Refresh to try again.';
    case 'capability_disabled':
    case 'capability_removed':
      return 'This Claude app cannot reach connectors from an artifact yet. Open the same link in a browser at claude.ai.';
    case '404':
      return 'That game is not published yet.';
    default:
      return err.message ?? 'Something went wrong loading the data.';
  }
}
