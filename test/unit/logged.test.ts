import { describe, expect, it } from 'vitest';
import { describeRequest, describeResult, loggedRunner } from '../../src/agent/logged';
import type { AgentRunner, RunResult } from '../../src/agent/runner';

describe('the log of claude runs', () => {
  const request = {
    prompt: 'secret code in the prompt',
    cwd: '/repo',
    tools: 'Read,Grep,Glob',
    maxBudgetUsd: 0.5,
  };

  it('says how a run started and ended, never what was asked or answered', () => {
    expect(describeRequest(request)).toBe(
      'new session, model default, tools Read,Grep,Glob, prompt 25 chars, limit $0.5, in /repo',
    );
    expect(
      describeRequest({ ...request, resume: 'abcdef123456', fork: true, model: 'sonnet' }),
    ).toMatch(/^forking session abcdef12, model sonnet,/);
    const done: RunResult = {
      text: 'the answer',
      costUsd: 0.0123,
      contextTokens: 23456,
      sessionId: 'feedface99',
    };
    expect(describeResult(done, 8250)).toBe(
      'done (8.3 s, $0.012, context 23k tokens, session feedface), 10 chars',
    );
    expect(describeResult({ text: '', error: 'Cancelled.' }, 1000)).toBe('cancelled (1.0 s)');
    expect(describeResult({ text: '', error: 'claude: not logged in' }, 500)).toBe(
      'failed (0.5 s): claude: not logged in',
    );
  });

  it('logs each run, a failure as a warning', async () => {
    const lines: string[] = [];
    const results: RunResult[] = [{ text: 'ok' }, { text: '', error: 'boom' }];
    const inner: AgentRunner = {
      run: () => ({ cancel: () => undefined, done: Promise.resolve(results.shift()!) }),
    };
    const runner = loggedRunner(inner, {
      info: (l) => lines.push(`info ${l}`),
      warn: (l) => lines.push(`warn ${l}`),
    });
    await runner.run(request, () => undefined).done;
    await runner.run(request, () => undefined).done;
    await Promise.resolve();
    expect(lines).toEqual([
      expect.stringMatching(/^info claude #1: new session/),
      expect.stringMatching(/^info claude #1: done \(/),
      expect.stringMatching(/^info claude #2: new session/),
      expect.stringMatching(/^warn claude #2: failed \(.*\): boom$/),
    ]);
    expect(lines.join('\n')).not.toContain('secret');
  });
});
