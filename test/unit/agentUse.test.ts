import { describe, expect, it } from 'vitest';
import { agentRunner } from '../../src/agent/agentRunner';
import { AgentUse, type Store } from '../../src/agent/agentUse';
import type { AgentRunner, RunRequest, RunResult } from '../../src/agent/runner';
import {
  agentLabel,
  agentTooltip,
  authOf,
  notAllowed,
  noticeDetail,
  noticeTitle,
  type AgentKind,
} from '../../src/shared/agentUse';

/** globalState in memory. */
function memory(): Store {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string) => m.get(k) as T | undefined,
    update: async (k, v) => {
      if (v === undefined) m.delete(k);
      else m.set(k, v);
    },
  };
}

/** A runner that answers at once as signed in with `source`, keeping what it was asked. */
function fakeRunner(source = 'none') {
  const runs: RunRequest[] = [];
  const runner: AgentRunner = {
    run: (request) => {
      runs.push(request);
      const result: RunResult = { text: 'ok', authSource: source };
      return { cancel: () => {}, done: Promise.resolve(result) };
    },
  };
  return { runner, runs };
}

const request = (prompt: string): RunRequest => ({ prompt, cwd: '/', tools: 'Read' });
const paths = (kind: AgentKind) => (kind === 'codex' ? '/bin/codex' : '/bin/claude');
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the agent runs as the reviewer knows them', () => {
  it('asks once before the first run, for the runs that start together', async () => {
    const asked: string[] = [];
    const use = new AgentUse(
      memory(),
      () => 'claude',
      paths,
      async (title, _b, detail) => {
        asked.push(`${title}\n${detail}`);
        return 'Continue';
      },
    );
    const { runner, runs } = fakeRunner();
    const gated = use.gate(runner);
    const [a, b] = await Promise.all([
      gated.run(request('a'), () => {}).done,
      gated.run(request('b'), () => {}).done,
    ]);
    expect([a.text, b.text]).toEqual(['ok', 'ok']);
    expect(runs.map((r) => r.prompt)).toEqual(['a', 'b']);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Review Desk runs your Claude Code\n/);
    expect(asked[0]).toContain('/bin/claude');
    await gated.run(request('c'), () => {}).done;
    expect(asked).toHaveLength(1);
  });

  it('runs nothing when the notice is dismissed, and asks again next time', async () => {
    let answer: string | undefined = undefined;
    let asked = 0;
    const use = new AgentUse(
      memory(),
      () => 'claude',
      paths,
      async () => {
        asked++;
        return answer;
      },
    );
    const { runner, runs } = fakeRunner();
    const gated = use.gate(runner);
    expect((await gated.run(request('a'), () => {}).done).error).toBe(notAllowed('claude'));
    expect(runs).toEqual([]);
    answer = 'Continue';
    expect((await gated.run(request('b'), () => {}).done).text).toBe('ok');
    expect(asked).toBe(2);
    expect(use.accepted()).toBe(true);
  });

  it('asks again for another agent: allowing Claude Code is not allowing Codex', async () => {
    let agent: AgentKind = 'claude';
    const asked: string[] = [];
    const use = new AgentUse(
      memory(),
      () => agent,
      paths,
      async (title) => {
        asked.push(title);
        return 'Continue';
      },
    );
    const gated = use.gate(fakeRunner().runner);
    await gated.run(request('a'), () => {}).done;
    agent = 'codex';
    await gated.run(request('b'), () => {}).done;
    await gated.run(request('c'), () => {}).done;
    expect(asked).toEqual([noticeTitle('claude'), noticeTitle('codex')]);
    expect([use.accepted('claude'), use.accepted('codex')]).toEqual([true, true]);
  });

  it("keeps each agent's account, and says when it changes", async () => {
    let agent: AgentKind = 'claude';
    const use = new AgentUse(
      memory(),
      () => agent,
      paths,
      async () => 'Continue',
    );
    let changes = 0;
    use.onDidChange(() => changes++);
    expect(use.info()).toEqual({
      agent: 'claude',
      path: '/bin/claude',
      source: undefined,
      auth: undefined,
    });
    await use.gate(fakeRunner('none').runner).run(request('a'), () => {}).done;
    await settle();
    expect(use.info().auth).toBe('plan');
    agent = 'codex';
    expect(use.info()).toMatchObject({ agent: 'codex', path: '/bin/codex', auth: undefined });
    await use.gate(fakeRunner('chatgpt').runner).run(request('b'), () => {}).done;
    await settle();
    expect(use.info()).toMatchObject({ agent: 'codex', auth: 'plan', source: 'chatgpt' });
    expect(changes).toBe(2);
  });

  it('tells a plan from an API key, for each agent, and names no amount', () => {
    expect(authOf('claude', 'none')).toBe('plan');
    expect(authOf('claude', 'ANTHROPIC_API_KEY')).toBe('apiKey');
    expect(authOf('claude', '/login managed key')).toBe('apiKey');
    expect(authOf('codex', 'chatgpt')).toBe('plan');
    expect(authOf('codex', 'apikey')).toBe('apiKey');
    expect(authOf('codex', 'other')).toBeUndefined();
    const infos = [
      { agent: 'claude' as const, path: '' },
      { agent: 'claude' as const, path: '/bin/claude' },
      { agent: 'claude' as const, path: '/bin/claude', auth: 'plan' as const, source: 'none' },
      {
        agent: 'claude' as const,
        path: '/bin/claude',
        auth: 'apiKey' as const,
        source: 'ANTHROPIC_API_KEY',
      },
      { agent: 'codex' as const, path: '' },
      { agent: 'codex' as const, path: '/bin/codex', auth: 'plan' as const, source: 'chatgpt' },
      { agent: 'codex' as const, path: '/bin/codex', auth: 'apiKey' as const, source: 'apikey' },
    ];
    expect(infos.map(agentLabel)).toEqual([
      'Claude Code not found',
      'Claude Code',
      'Claude Code · Claude plan',
      'Claude Code · API key',
      'Codex not found',
      'Codex · ChatGPT plan',
      'Codex · API key',
    ]);
    const texts = [
      ...infos.map(agentTooltip),
      noticeDetail('claude', '/bin/claude'),
      noticeDetail('codex', '/bin/codex'),
      notAllowed('codex'),
    ];
    for (const t of texts) expect(t).not.toMatch(/\$\d|USD|cost/i);
    expect(noticeDetail('codex', '/bin/codex')).toMatch(/ChatGPT plan's usage limits.*API key/s);
  });
});

describe('runs go to the agent chosen', () => {
  it('runs with the agent it was allowed for, even when the setting changed meanwhile', async () => {
    let agent: AgentKind = 'claude';
    let allow: ((v: string) => void) | undefined;
    const use = new AgentUse(
      memory(),
      () => agent,
      paths,
      () => new Promise((r) => (allow = r)),
    );
    const claude = fakeRunner();
    const codex = fakeRunner();
    const gated = use.gate(
      agentRunner(
        () => agent,
        { claude: claude.runner, codex: codex.runner },
        () => undefined,
      ),
    );
    const done = gated.run(request('a'), () => {}).done;
    // Another window switches to Codex while Claude Code's notice is open.
    agent = 'codex';
    allow!('Continue');
    await done;
    expect([claude.runs.length, codex.runs.length]).toEqual([1, 0]);
  });

  it("runs each request with the agent chosen now, with that agent's model", async () => {
    let agent: AgentKind = 'claude';
    const claude = fakeRunner();
    const codex = fakeRunner();
    const runner = agentRunner(
      () => agent,
      { claude: claude.runner, codex: codex.runner },
      () => 'gpt-test',
    );
    await runner.run({ ...request('a'), model: 'sonnet' }, () => {}).done;
    agent = 'codex';
    await runner.run({ ...request('b'), model: 'sonnet' }, () => {}).done;
    expect(claude.runs.map((r) => [r.prompt, r.model])).toEqual([['a', 'sonnet']]);
    expect(codex.runs.map((r) => [r.prompt, r.model])).toEqual([['b', 'gpt-test']]);
  });
});
