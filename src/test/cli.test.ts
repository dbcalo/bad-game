import { describe, expect, it } from 'vitest';
import { parseAgentFile } from '../cli/agents.js';
import { extractJson } from '../cli/main.js';

describe('extractJson', () => {
  it('pulls a JSON object out of prose and code fences', () => {
    expect(extractJson('Sure! ```json\n{"a": 1, "b": "x}y"}\n```')).toEqual({ a: 1, b: 'x}y' });
    expect(extractJson('{"notes":"he said \\"no\\"","say":"ok"}')).toEqual({ notes: 'he said "no"', say: 'ok' });
  });
  it('rejects garbage', () => {
    expect(() => extractJson('no json here')).toThrow(/no JSON/);
    expect(() => extractJson('{"a": ')).toThrow(/unterminated/);
    expect(() => extractJson('{a: 1}')).toThrow(/not valid JSON/);
  });
});

describe('agent files', () => {
  const body = '\nYou are a test agent who says the same thing every time and never lies about it.\n';
  it('parses frontmatter', () => {
    const def = parseAgentFile(`---\nid: test-bot\nname: "Test Bot"\nmodel: haiku\nauthor: me\n---${body}`, 'x.md');
    expect(def.id).toBe('test-bot');
    expect(def.name).toBe('Test Bot');
    expect(def.persona).toContain('test agent');
  });
  it('rejects bad ids and missing fields', () => {
    expect(() => parseAgentFile(`---\nid: Bad Id\nname: x\nmodel: haiku\n---${body}`, 'x.md')).toThrow(/must match/);
    expect(() => parseAgentFile(`---\nid: ok\nname: x\n---${body}`, 'x.md')).toThrow(/missing "model"/);
    expect(() => parseAgentFile(`---\nid: ok\nname: x\nmodel: haiku\n---\nshort`, 'x.md')).toThrow(/too short/);
  });
});
