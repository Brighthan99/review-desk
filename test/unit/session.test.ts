import { describe, expect, it } from 'vitest';
import {
  ofAgent,
  SESSION_IDLE_MS,
  SESSION_MAX_TOKENS,
  worthContinuing,
} from '../../src/agent/session';

describe('worthContinuing', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('continues a session that ran a moment ago and is not too big', () => {
    expect(worthContinuing({ usedAt: ago(60_000), tokens: 30_000 }, now)).toBe(true);
    expect(worthContinuing({ usedAt: ago(0) }, now)).toBe(true);
  });

  it('starts over once the prompt cache has expired, or when the age is unknown', () => {
    expect(worthContinuing({ usedAt: ago(SESSION_IDLE_MS), tokens: 1000 }, now)).toBe(false);
    expect(worthContinuing({ usedAt: ago(2 * 24 * 3600_000) }, now)).toBe(false);
    expect(worthContinuing({ tokens: 1000 }, now)).toBe(false);
    expect(worthContinuing(undefined, now)).toBe(false);
    expect(worthContinuing({ usedAt: 'not a date' }, now)).toBe(false);
  });

  it('starts over when the session has grown big', () => {
    expect(worthContinuing({ usedAt: ago(1000), tokens: SESSION_MAX_TOKENS }, now)).toBe(false);
  });
});

describe('sessions of one agent', () => {
  it('continues a session only with the agent it is of', () => {
    expect(ofAgent('3f2a-claude', 'claude')).toBe(true);
    expect(ofAgent('3f2a-claude', undefined)).toBe(true);
    expect(ofAgent('3f2a-claude', 'codex')).toBe(false);
    expect(ofAgent('codex:t1', 'codex')).toBe(true);
    expect(ofAgent('codex:t1', 'claude')).toBe(false);
    expect(ofAgent(undefined, 'claude')).toBe(false);
  });
});
