import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveClaudePath } from '../../src/agent/claudePath';
import { notFound } from '../../src/shared/agentUse';
import { claudeArgs, ClaudeCliRunner, StreamJsonParser } from '../../src/agent/runner';

const FAKE = path.resolve(__dirname, '../fixtures/fake-claude.mjs');

describe('StreamJsonParser', () => {
  const line = (o: object) => JSON.stringify(o);

  it('builds the text from deltas, restarts on a new message and ends with the result', () => {
    const p = new StreamJsonParser();
    expect(p.push(line({ type: 'system', subtype: 'init', session_id: 's1' }))).toBe(false);
    expect(p.sessionId).toBe('s1');
    p.push(line({ type: 'stream_event', event: { type: 'message_start' } }));
    p.push(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading ' } },
      }),
    );
    p.push(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'the file' } },
      }),
    );
    expect(p.text).toBe('Reading the file');
    p.push(line({ type: 'stream_event', event: { type: 'message_start' } }));
    p.push(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer' } },
      }),
    );
    expect(p.text).toBe('Answer');
    p.push(
      line({
        type: 'result',
        subtype: 'success',
        result: 'Final answer',
        total_cost_usd: 0.02,
        session_id: 's2',
      }),
    );
    expect(p).toMatchObject({
      text: 'Final answer',
      finished: true,
      costUsd: 0.02,
      sessionId: 's2',
      error: undefined,
    });
  });

  it("measures the session's context from the last message's usage", () => {
    const p = new StreamJsonParser();
    const usage = (cacheRead: number) =>
      line({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: cacheRead,
            output_tokens: 40,
          },
        },
      });
    expect(p.push(usage(1000))).toBe(false);
    p.push(usage(9000));
    expect(p.contextTokens).toBe(9145);
  });

  it('reports error results and ignores junk', () => {
    const p = new StreamJsonParser();
    expect(p.push('not json')).toBe(false);
    expect(p.push('')).toBe(false);
    p.push(line({ type: 'result', subtype: 'error_max_budget_usd', is_error: true }));
    expect(p.error).toBe('error_max_budget_usd');
  });
});

describe('StreamJsonParser: the account', () => {
  it('keeps how the run is signed in, from its first message', () => {
    const p = new StreamJsonParser();
    p.push(
      JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' }),
    );
    expect(p.authSource).toBe('none');
  });
});

describe('claudeArgs', () => {
  it('forks only when asked', () => {
    expect(
      claudeArgs({
        prompt: '',
        cwd: '',
        tools: 'Read',
        resume: 's',
        fork: true,
        maxBudgetUsd: 0.5,
      }),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--setting-sources',
      'user',
      '--tools',
      'Read',
      '--strict-mcp-config',
      '--resume',
      's',
      '--fork-session',
      '--max-budget-usd',
      '0.5',
    ]);
    expect(claudeArgs({ prompt: '', cwd: '', tools: 'Read' })).not.toContain('--resume');
  });

  it('passes how hard to think, when set', () => {
    expect(claudeArgs({ prompt: '', cwd: '', tools: 'Read', effort: 'low' })).toEqual(
      expect.arrayContaining(['--effort', 'low']),
    );
    expect(claudeArgs({ prompt: '', cwd: '', tools: 'Read' })).not.toContain('--effort');
  });

  it("reads the user's own Claude Code settings only, not the repository's", () => {
    const args = claudeArgs({ prompt: '', cwd: '', tools: 'Read' });
    expect(
      args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2),
    ).toEqual(['--setting-sources', 'user']);
  });
});

describe('resolveClaudePath', () => {
  const at =
    (...files: string[]) =>
    (f: string) =>
      files.includes(f);
  const bin = path.join(path.sep, 'opt', 'bin');
  const claude = path.join(bin, 'claude');

  it('takes the setting only as an absolute path to a file that is there', () => {
    expect(resolveClaudePath({ configured: claude, pathEnv: '', exists: at(claude) })).toBe(claude);
    // Relative: it would be found in the folder under review.
    expect(
      resolveClaudePath({ configured: 'tools/claude', pathEnv: bin, exists: at(claude) }),
    ).toBe('');
    expect(resolveClaudePath({ configured: claude, pathEnv: bin, exists: at() })).toBe('');
  });

  it('looks in the absolute PATH entries, ~/.local/bin, then the Claude Code extension', () => {
    const local = path.join('.', 'claude');
    expect(
      resolveClaudePath({
        configured: '',
        pathEnv: ['.', 'node_modules/.bin', bin].join(path.delimiter),
        exists: at(local, path.join('node_modules/.bin', 'claude'), claude),
      }),
    ).toBe(claude);
    // Claude Code's own installer, when VS Code's PATH lacks it (started from the Dock).
    const home = path.join(path.sep, 'Users', 'me');
    const installed = path.join(home, '.local', 'bin', 'claude');
    expect(resolveClaudePath({ configured: '', pathEnv: bin, home, exists: at(installed) })).toBe(
      installed,
    );
    expect(resolveClaudePath({ configured: '', pathEnv: '.', exists: at(local) })).toBe('');
  });

  it('on Windows, runs the claude.exe of an npm install, not its claude.cmd', () => {
    const w = path.win32;
    const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm';
    const exe = w.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const lookup = { configured: '', pathEnv: `.;${npm}`, platform: 'win32' as const };
    expect(resolveClaudePath({ ...lookup, exists: at(w.join(npm, 'claude.cmd'), exe) })).toBe(exe);
    // Only the .cmd: nothing runnable without a shell.
    expect(resolveClaudePath({ ...lookup, exists: at(w.join(npm, 'claude.cmd')) })).toBe('');
    const ext = 'C:\\ext';
    const bundled = w.join(ext, 'resources', 'native-binary', 'claude.exe');
    expect(resolveClaudePath({ ...lookup, bundledDir: ext, exists: at(bundled) })).toBe(bundled);
  });
});

describe('ClaudeCliRunner', () => {
  const runner = new ClaudeCliRunner(() => FAKE);

  it('ends with the error when claude stops before reading a long prompt (no EPIPE thrown)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-early-'));
    const quits = path.join(dir, 'claude');
    fs.writeFileSync(quits, '#!/bin/sh\nexit 3\n');
    fs.chmodSync(quits, 0o755);
    try {
      const r = await new ClaudeCliRunner(() => quits).run(
        // Far beyond a pipe's buffer: written while claude is gone already.
        { prompt: 'x'.repeat(4_000_000), cwd: dir, tools: 'Read' },
        () => {},
      ).done;
      expect(r.error).toMatch(/exited without finishing \(code 3\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says how to get Claude Code when there is none, running nothing', async () => {
    const none = new ClaudeCliRunner(() => '');
    const r = await none.run({ prompt: 'x', cwd: process.cwd(), tools: 'Read' }, () => {}).done;
    expect(r.error).toBe(notFound('claude'));
  });

  it('streams the answer and returns the session of the fork', async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-runner-')), 'log');
    process.env.FAKE_CLAUDE_LOG = log;
    try {
      const seen: string[] = [];
      const r = await runner.run(
        { prompt: 'A question', cwd: os.tmpdir(), tools: 'Read', resume: 'explain', fork: true },
        (t) => seen.push(t),
      ).done;
      expect(r.error).toBeUndefined();
      expect(r.text).toBe('Yes. Each request calls `refresh` on its own.');
      expect(r.sessionId).toMatch(/^fork-/);
      expect(seen.length).toBeGreaterThan(2);
      expect(seen[seen.length - 1]).toBe(r.text);
      const logged = JSON.parse(fs.readFileSync(log, 'utf8').trim());
      expect(logged.prompt).toBe('A question');
      expect(logged.args).toContain('--fork-session');
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it('can be cancelled and reports failures', async () => {
    const h = runner.run({ prompt: '[slow]', cwd: os.tmpdir(), tools: 'Read' }, () => {});
    setTimeout(() => h.cancel(), 400);
    expect((await h.done).error).toBe('Cancelled.');
    expect(
      (await runner.run({ prompt: '[fail]', cwd: os.tmpdir(), tools: 'Read' }, () => {}).done)
        .error,
    ).toBe('Stopped at the cost limit before finishing.');
    const missing = new ClaudeCliRunner(() => '/no/such/claude');
    expect(
      (await missing.run({ prompt: 'x', cwd: os.tmpdir(), tools: 'Read' }, () => {}).done).error,
    ).toMatch(/Could not run claude/);
  });
});
