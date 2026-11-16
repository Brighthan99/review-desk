import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCodexPath } from '../../src/agent/codexPath';
import {
  codexArgs,
  codexAuthFrom,
  CodexCliRunner,
  CodexJsonParser,
} from '../../src/agent/codexRunner';
import { claudeArgs } from '../../src/agent/runner';
import { claudeAccountFrom, codexAccountFrom } from '../../src/agent/agentStatus';
import { notFound, signInCommand, statusText, type AgentStatus } from '../../src/shared/agentUse';

const FAKE = path.resolve(__dirname, '../fixtures/fake-codex.mjs');

describe('codexArgs', () => {
  const base = { prompt: '', cwd: '', tools: 'Read' };

  it('runs read-only with JSON events, the prompt on stdin', () => {
    expect(codexArgs(base)).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-c',
      'web_search="disabled"',
      '-',
    ]);
    expect(codexArgs({ ...base, model: 'gpt-x', effort: 'low' })).toEqual(
      expect.arrayContaining(['--model', 'gpt-x', '-c', 'model_reasoning_effort="low"']),
    );
  });

  it("leaves out the user's Codex config (its MCP servers) and web search", () => {
    const args = codexArgs(base);
    expect(args).toContain('--ignore-user-config');
    expect(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2)).toEqual([
      '-c',
      'web_search="disabled"',
    ]);
  });

  it("continues or branches off its own sessions only, never Claude Code's", () => {
    expect(codexArgs({ ...base, resume: 'codex:t1' }).slice(-3)).toEqual(['resume', 't1', '-']);
    expect(codexArgs({ ...base, resume: 'codex:t1', fork: true }).slice(-3)).toEqual([
      'fork',
      't1',
      '-',
    ]);
    // A Claude Code session (the agent was switched): a new Codex session.
    expect(codexArgs({ ...base, resume: 'c0ffee' })).not.toContain('resume');
    expect(claudeArgs({ ...base, resume: 'codex:t1' })).not.toContain('--resume');
  });
});

describe('CodexJsonParser', () => {
  it('keeps the thread, the latest agent message and the usage', () => {
    const p = new CodexJsonParser();
    const lines = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Let me look.' } },
      { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'cat a' } },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: '[how] Done' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 900, cached_input_tokens: 800, output_tokens: 100 },
      },
    ];
    const changed = lines.map((l) => p.push(JSON.stringify(l)));
    expect(changed.filter(Boolean)).toHaveLength(2);
    expect([p.sessionId, p.text, p.contextTokens, p.finished, p.error]).toEqual([
      'codex:t1',
      '[how] Done',
      1000,
      true,
      undefined,
    ]);
  });

  it('says how a turn failed', () => {
    const p = new CodexJsonParser();
    p.push(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }));
    expect([p.finished, p.error]).toEqual([true, 'usage limit reached']);
  });
});

describe('how Codex is signed in', () => {
  it('reads codex login status, never keeping the key', () => {
    expect(codexAuthFrom('Logged in using ChatGPT')).toBe('chatgpt');
    expect(codexAuthFrom('API key configured - sk-proj-***abcd')).toBe('apikey');
    expect(codexAuthFrom('Not logged in')).toBe('none');
    expect(codexAuthFrom('Logged in using access token')).toBe('other');
  });
});

describe('resolveCodexPath', () => {
  const at =
    (...files: string[]) =>
    (f: string) =>
      files.includes(f);

  it('takes the setting only as an absolute path to a file that is there', () => {
    expect(
      resolveCodexPath({ configured: '/opt/codex', pathEnv: '', exists: at('/opt/codex') }),
    ).toBe('/opt/codex');
    expect(
      resolveCodexPath({ configured: 'bin/codex', pathEnv: '', exists: at('bin/codex') }),
    ).toBe('');
  });

  it('runs a native codex on the PATH (Homebrew), skipping relative entries', () => {
    expect(
      resolveCodexPath({
        configured: '',
        pathEnv: '.:/opt/homebrew/bin',
        platform: 'darwin',
        arch: 'arm64',
        exists: at('codex', './codex', '/opt/homebrew/bin/codex'),
        realpath: (f) =>
          f === '/opt/homebrew/bin/codex' ? '/opt/homebrew/Cellar/codex/1/bin/codex' : f,
      }),
    ).toBe('/opt/homebrew/bin/codex');
  });

  it('runs the native binary of an npm install, not its Node launcher', () => {
    const lib = '/n/lib/node_modules/@openai';
    const nested = `${lib}/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`;
    const hoisted = `${lib}/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`;
    const lookup = {
      configured: '',
      pathEnv: '/n/bin',
      platform: 'darwin' as const,
      arch: 'arm64',
      realpath: (f: string) => (f === '/n/bin/codex' ? `${lib}/codex/bin/codex.js` : f),
    };
    expect(resolveCodexPath({ ...lookup, exists: at('/n/bin/codex', nested) })).toBe(nested);
    expect(resolveCodexPath({ ...lookup, exists: at('/n/bin/codex', hoisted) })).toBe(hoisted);
    // The same launcher set as reviewDesk.codexPath (what `which codex` says): its binary too.
    expect(
      resolveCodexPath({
        ...lookup,
        configured: '/n/bin/codex',
        exists: at('/n/bin/codex', nested),
      }),
    ).toBe(nested);
    // No native binary: not runnable without node.
    expect(resolveCodexPath({ ...lookup, exists: at('/n/bin/codex') })).toBe('');
  });

  it('on Windows, runs the codex.exe of an npm install, not its codex.cmd', () => {
    const w = path.win32;
    const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm';
    const exe = w.join(
      npm,
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    );
    const lookup = { configured: '', pathEnv: `.;${npm}`, platform: 'win32' as const, arch: 'x64' };
    expect(resolveCodexPath({ ...lookup, exists: at(w.join(npm, 'codex.cmd'), exe) })).toBe(exe);
    expect(resolveCodexPath({ ...lookup, exists: at(w.join(npm, 'codex.cmd')) })).toBe('');
  });
});

describe('CodexCliRunner', () => {
  it('runs codex and reads its answer, session and account', async () => {
    const runner = new CodexCliRunner(() => FAKE);
    const seen: string[] = [];
    const r = await runner.run(
      { prompt: '[Review Desk: explain]\nwhy?', cwd: process.cwd(), tools: 'Read' },
      (t) => seen.push(t),
    ).done;
    expect(r.error).toBeUndefined();
    expect(r.text).toMatch(/^\[risk\] May refresh twice at once/);
    expect(r.sessionId).toMatch(/^codex:/);
    expect(r.authSource).toBe('chatgpt');
    expect(seen.at(-1)).toBe(r.text);
  });

  it('says how to get Codex when there is none, running nothing', async () => {
    const r = await new CodexCliRunner(() => '').run(
      { prompt: 'x', cwd: process.cwd(), tools: 'Read' },
      () => {},
    ).done;
    expect(r.error).toBe(notFound('codex'));
  });
});

describe('how each agent stands', () => {
  it("reads Claude Code's auth status: its plan, an API key, a cloud provider, signed out", () => {
    expect(
      claudeAccountFrom(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: 'me@example.com',
          subscriptionType: 'max',
        }),
      ),
    ).toEqual({
      signedIn: true,
      auth: 'plan',
      plan: 'Max',
      account: 'me@example.com',
      provider: undefined,
      source: 'none',
    });
    expect(
      claudeAccountFrom(
        JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }),
      ),
    ).toMatchObject({ signedIn: true, auth: 'apiKey', source: 'api_key' });
    expect(
      claudeAccountFrom(JSON.stringify({ loggedIn: true, apiProvider: 'bedrock' })),
    ).toMatchObject({
      provider: 'Amazon Bedrock',
    });
    expect(claudeAccountFrom(JSON.stringify({ loggedIn: false }))).toEqual({ signedIn: false });
    expect(claudeAccountFrom('not json')).toEqual({});
  });

  it("reads Codex's login status", () => {
    expect(codexAccountFrom('Logged in using ChatGPT')).toEqual({
      signedIn: true,
      auth: 'plan',
      source: 'chatgpt',
    });
    expect(codexAccountFrom('Not logged in')).toEqual({ signedIn: false });
  });

  it('says it in a few words, and how to sign in', () => {
    const at = (s: Partial<AgentStatus>): AgentStatus => ({
      kind: 'claude',
      path: '/bin/claude',
      ...s,
    });
    expect(
      [
        at({ path: '' }),
        at({ signedIn: false }),
        at({ signedIn: true, auth: 'plan', plan: 'Max' }),
        at({ kind: 'codex', signedIn: true, auth: 'plan' }),
        at({ signedIn: true, auth: 'apiKey' }),
        at({ signedIn: true, provider: 'Amazon Bedrock' }),
      ].map(statusText),
    ).toEqual([
      'not installed',
      'not signed in',
      'Claude Max plan',
      'ChatGPT plan',
      'API key',
      'Amazon Bedrock',
    ]);
    expect(signInCommand('claude', '/bin/claude')).toBe('/bin/claude auth login');
    expect(signInCommand('codex', '/My Apps/codex')).toBe('"/My Apps/codex" login');
  });
});
