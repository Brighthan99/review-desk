import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { statusText, type AgentKind, type AgentStatus } from '../../src/shared/agentUse';
import type { ToPanel } from '../../src/shared/protocol';
import {
  activate,
  answering,
  argAfter,
  fakeCalls,
  freshBranch,
  run,
  topRow,
  until,
  useFakeClaude,
  workspace,
} from './helpers';

describe('explanations on request', () => {
  let api: ExtensionApi;
  const posted: ToPanel[] = [];
  const card = (id: string) => api.controller.resolved.find((a) => a.id === id);
  const panelState = () =>
    posted.flatMap((m) => (m.type === 'state' && m.state ? [m.state] : [])).at(-1);
  const lastSummary = () => posted.filter((m) => m.type === 'summary').at(-1);
  const summaryRow = async () => {
    return api.tree.getTreeItem((await topRow(api, 'summary'))!);
  };

  /** Selects 1-based lines [from, to] of a working tree file and asks for an explanation. */
  async function explain(file: string, from: number, to = from): Promise<string> {
    const editor = await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(workspace(), file)),
      { viewColumn: vscode.ViewColumn.One, preview: false },
    );
    editor.selection =
      from === to
        ? new vscode.Selection(from - 1, 3, from - 1, 3)
        : new vscode.Selection(from - 1, 0, to - 1, 999);
    const id = await vscode.commands.executeCommand<string>('reviewDesk.explainSelection');
    assert.ok(id, 'a card id');
    return id;
  }

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-explain');
    await useFakeClaude(true);
    api.panel.host.onDidPost((m) => posted.push(m));
  });

  after(async () => {
    delete process.env.FAKE_CLAUDE_FAIL;
    delete process.env.FAKE_CLAUDE_SLOW;
    await useFakeClaude(false);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('starts a review if needed and explains the selected lines of a changed file', async () => {
    const id = await explain('src/auth/session.ts', 8, 13);
    assert.strictEqual(api.controller.target?.head.ref, 'it-explain');
    const pending = card(id)!;
    assert.deepStrictEqual(
      [pending.file, pending.side, pending.resolvedStart, pending.resolvedEnd, pending.pending],
      ['src/auth/session.ts', 'new', 8, 13, true],
    );
    assert.strictEqual(api.panel.activeId, id);

    await until('explained', () => card(id)?.pending === undefined);
    const done = card(id)!;
    assert.deepStrictEqual(
      [done.kind, done.title, done.group],
      ['risk', 'May refresh twice at once', 'src/auth/session.ts'],
    );
    assert.match(done.body, /both call `refresh`/);
    assert.ok(
      posted.some((m) => m.type === 'explain' && m.cardId === id && !m.done && m.text),
      'streamed into the panel',
    );

    const call = fakeCalls().at(-1)!;
    assert.strictEqual(argAfter(call.args, '--resume'), undefined, 'a new session');
    assert.strictEqual(argAfter(call.args, '--tools'), 'Read,Grep,Glob');
    assert.match(call.prompt, /Files changed in this review \(4\)/);
    assert.match(call.prompt, /Diff of src\/auth\/session\.ts \(line numbers/);
    assert.match(
      call.prompt,
      /Code to explain: src\/auth\/session\.ts 8–13 \(code after the change\)/,
    );
    assert.match(call.prompt, /Write the title and body in English\./, 'English by default');
    const session = api.controller.review!.session!;
    assert.match(session.id, /^fork-/);
    assert.strictEqual(session.tokens, 1000, 'its size, for deciding when to start over');
    assert.ok(Date.now() - Date.parse(session.usedAt!) < 60_000, 'when it last ran');
  });

  it('continues the same session for the next request, without repeating the diff', async () => {
    const session = api.controller.review!.session!.id;
    const id = await explain('src/auth/session.ts', 17, 18);
    await until('explained', () => card(id)?.pending === undefined);
    const call = fakeCalls().at(-1)!;
    assert.strictEqual(argAfter(call.args, '--resume'), session);
    assert.ok(!call.args.includes('--fork-session'));
    assert.doesNotMatch(call.prompt, /Files changed|Diff of/);
    assert.match(call.prompt, /Code to explain: src\/auth\/session\.ts 17–18/);
    assert.strictEqual(api.controller.review!.session!.id, session);
  });

  it('explains an unchanged file and decorates it', async () => {
    const id = await explain('src/auth/token.ts', 12, 14);
    await until('explained', () => card(id)?.pending === undefined);
    assert.strictEqual(card(id)!.file, 'src/auth/token.ts');
    assert.match(
      fakeCalls().at(-1)!.prompt,
      /src\/auth\/token\.ts 12–14 \(a file not changed in this review\)/,
    );
    const uri = vscode.Uri.file(path.join(workspace(), 'src/auth/token.ts')).toString();
    await until('badge on token.ts', () => api.controller.decorator.applied.get(uri) === 1);
  });

  it('reuses the card of a range already explained', async () => {
    const calls = fakeCalls().length;
    const first = api.controller.resolved.find((a) => a.resolvedStart === 8)!;
    assert.strictEqual(await explain('src/auth/session.ts', 8, 13), first.id);
    assert.strictEqual(fakeCalls().length, calls);
  });

  it('forks the explaining session for a question on the card', async () => {
    const session = api.controller.review!.session!.id;
    const first = api.controller.resolved.find((a) => a.resolvedStart === 8)!;
    await api.panel.receive({
      type: 'ask',
      cardId: first.id,
      text: 'How do we stop it?',
      useSelection: false,
    });
    await until('answered', () => card(first.id)?.thread?.length === 2);
    const call = fakeCalls().at(-1)!;
    assert.strictEqual(argAfter(call.args, '--resume'), session);
    assert.ok(call.args.includes('--fork-session'));
  });

  it('keeps a failed request as a card that can be retried or removed', async () => {
    process.env.FAKE_CLAUDE_FAIL = '1';
    const id = await explain('src/lib/api-client.ts', 4);
    await until('failed', () =>
      posted.some((m) => m.type === 'explain' && m.cardId === id && m.done && !!m.error),
    );
    assert.strictEqual(card(id)?.pending, true);

    delete process.env.FAKE_CLAUDE_FAIL;
    await api.panel.receive({ type: 'retry', id });
    await until('explained on retry', () => card(id)?.pending === undefined);

    await api.panel.receive({ type: 'remove', id });
    await until('removed', () => card(id) === undefined);
  });

  it('asks once before Claude Code first runs, and shows whose account it runs with', async () => {
    await api.agentUse.reset('claude');
    const asked: string[] = [];
    let answer: string | undefined;
    const restore = answering(api, {
      choose: async (message, _buttons, detail) => {
        asked.push(`${message}\n${detail}`);
        return answer;
      },
    });
    try {
      // Dismissed: nothing runs, and the card says why.
      const calls = fakeCalls().length;
      const id = await explain('src/lib/http.ts', 2);
      await until('not run', () =>
        posted.some((m) => m.type === 'explain' && m.cardId === id && m.done && !!m.error),
      );
      assert.strictEqual(fakeCalls().length, calls, 'Claude Code was not run');
      assert.match(asked[0], /^Review Desk runs your Claude Code\n/);
      assert.match(asked[0], /usage limits/);
      // Allowed on retry: it runs, and is not asked again.
      answer = 'Continue';
      await api.panel.receive({ type: 'retry', id });
      await until('explained on retry', () => !!card(id)?.body && card(id)?.pending === undefined);
      assert.strictEqual(asked.length, 2);
      assert.ok(api.agentUse.accepted('claude'));
      // The fake run reports a signed-in Claude account, as a real one does.
      await until('the account shown', () => panelState()?.agent?.auth === 'plan');
      assert.ok(panelState()!.agent!.path.endsWith('fake-claude.mjs'));
      await api.panel.receive({ type: 'remove', id });
    } finally {
      restore();
      await api.agentUse.accept('claude');
    }
  });

  it('runs Codex instead when chosen: notes, questions on them, and its account', async () => {
    const ext = vscode.extensions.getExtension('brighthan99.review-desk')!;
    const config = () => vscode.workspace.getConfiguration('reviewDesk');
    await config().update(
      'codexPath',
      path.join(ext.extensionPath, 'test', 'fixtures', 'fake-codex.mjs'),
      vscode.ConfigurationTarget.Global,
    );
    await config().update('agent', 'codex', vscode.ConfigurationTarget.Global);
    try {
      await until('the panel says Codex', () => panelState()?.agent?.agent === 'codex');
      const id = await explain('src/lib/http.ts', 3);
      await until('explained by Codex', () => card(id)?.pending === undefined);
      const call = fakeCalls().at(-1)! as ReturnType<typeof fakeCalls>[number] & { agent?: string };
      assert.strictEqual(call.agent, 'codex');
      assert.deepStrictEqual(call.args.slice(0, 4), ['exec', '--json', '--sandbox', 'read-only']);
      // Not the user's Codex config (its MCP servers), and no web search.
      assert.ok(call.args.includes('--ignore-user-config'));
      assert.ok(call.args.includes('web_search="disabled"'));
      assert.ok(call.prompt.startsWith('[Review Desk: explain]'));
      // Claude Code's session of a moment ago is not Codex's: a new session, told all a first
      // one is (the files changed), and Codex's session kept as Codex's.
      assert.match(call.prompt, /Files changed in this review/);
      assert.ok(!call.args.includes('resume'));
      await until('session kept', () => api.controller.review?.session?.agent === 'codex');
      assert.strictEqual(card(id)!.title, 'May refresh twice at once');
      await until('its account shown', () => panelState()?.agent?.auth === 'plan');

      // A question on the note branches off the Codex session that wrote it.
      await api.panel.receive({
        type: 'ask',
        cardId: id,
        text: 'Why twice?',
        useSelection: false,
      });
      await until('answered', () => (card(id)?.thread?.length ?? 0) >= 2);
      const asked = fakeCalls().at(-1)!;
      assert.ok(asked.args.includes('fork'), `forked: ${asked.args.join(' ')}`);
      await api.panel.receive({ type: 'remove', id });
    } finally {
      await config().update('agent', undefined, vscode.ConfigurationTarget.Global);
      await config().update('codexPath', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('picks the agent from the list of agents, each with how it stands', async () => {
    const ext = vscode.extensions.getExtension('brighthan99.review-desk')!;
    const config = () => vscode.workspace.getConfiguration('reviewDesk');
    const fakeCodex = path.join(ext.extensionPath, 'test', 'fixtures', 'fake-codex.mjs');
    await config().update('codexPath', fakeCodex, vscode.ConfigurationTarget.Global);
    const listed: AgentStatus[][] = [];
    const warned: string[] = [];
    const asked: string[] = [];
    let pick: string | undefined = 'codex';
    const restore = answering(api, {
      pickAgent: async (current, load) => {
        assert.strictEqual(current, config().get('agent'));
        listed.push(await load());
        return pick as AgentKind;
      },
      warn: (m) => void warned.push(m),
      choose: async (m) => {
        asked.push(m);
        return undefined;
      },
    });
    try {
      // Both listed with how they stand; Codex picked.
      assert.strictEqual(await vscode.commands.executeCommand('reviewDesk.chooseAgent'), 'codex');
      const [claude, codex] = listed[0];
      assert.deepStrictEqual(
        [statusText(claude), claude.account, statusText(codex)],
        ['Claude Max plan', 'reviewer@example.com', 'ChatGPT plan'],
      );
      assert.strictEqual(config().get('agent'), 'codex');
      // Its account is known before its first run.
      await until('the panel says so', () => panelState()?.agent?.auth === 'plan');
      assert.strictEqual(panelState()!.agent!.agent, 'codex');

      // An agent that is not signed in: picked, with a way to sign in.
      process.env.FAKE_CODEX_AUTH = 'none';
      await vscode.commands.executeCommand('reviewDesk.chooseAgent');
      assert.deepStrictEqual(asked, ['Codex is not signed in.']);
      delete process.env.FAKE_CODEX_AUTH;

      // One not installed: not picked, said how to install it.
      pick = 'claude';
      await vscode.commands.executeCommand('reviewDesk.chooseAgent');
      assert.strictEqual(config().get('agent'), 'claude');
      await config().update('codexPath', '/nowhere/codex', vscode.ConfigurationTarget.Global);
      pick = 'codex';
      assert.strictEqual(await vscode.commands.executeCommand('reviewDesk.chooseAgent'), undefined);
      assert.strictEqual(config().get('agent'), 'claude');
      assert.match(warned.at(-1)!, /Codex was not found/);
      assert.strictEqual(statusText(listed.at(-1)![1]), 'not installed');
    } finally {
      restore();
      delete process.env.FAKE_CODEX_AUTH;
      await config().update('agent', undefined, vscode.ConfigurationTarget.Global);
      await config().update('codexPath', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('does not run a question cancelled while it waited for its turn', async () => {
    const config = () => vscode.workspace.getConfiguration('reviewDesk');
    await config().update('maxConcurrentQuestions', 1, vscode.ConfigurationTarget.Global);
    const before = fakeCalls().length;
    try {
      // The first holds the only turn a while; the second waits for it.
      const first = api.panel.questions.ask(null, 'Why so slow? [slow]');
      await until('first running', () => fakeCalls().length === before + 1);
      const second = api.panel.questions.ask(null, 'And this one?');
      await until('second waiting', () =>
        api.controller.resolved.some((a) => a.title === 'And this one?'),
      );
      const waiting = api.controller.resolved.find((a) => a.title === 'And this one?')!;
      api.panel.questions.cancel(waiting.id);
      await Promise.all([first, second]);
      assert.strictEqual(fakeCalls().length, before + 1, 'the cancelled one never ran');
      assert.strictEqual(api.panel.questions.answers.get(waiting.id)?.error, 'Cancelled.');
    } finally {
      await config().update('maxConcurrentQuestions', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('summarizes the whole change on request, in a session of its own', async () => {
    const session = api.controller.review!.session!.id;
    const calls = fakeCalls().length;
    assert.strictEqual((await summaryRow()).description, '4 files · click to write');

    assert.strictEqual(await vscode.commands.executeCommand('reviewDesk.summarize'), true);
    await until('summary written', () => !!api.controller.review?.overview);
    await until('done', () => !api.panel.explain.isSummarizing);
    assert.match(api.controller.review!.overview!, /^Expired tokens are now refreshed/);
    assert.ok(
      posted.some((m) => m.type === 'summary' && m.run && !m.run.done && m.run.text),
      'streamed into the panel',
    );
    assert.deepStrictEqual(lastSummary(), { type: 'summary', run: null });
    assert.ok(posted.some((m) => m.type === 'focusSummary'));

    assert.strictEqual(fakeCalls().length, calls + 1);
    const call = fakeCalls().at(-1)!;
    assert.strictEqual(argAfter(call.args, '--resume'), undefined, 'a new session');
    assert.strictEqual(argAfter(call.args, '--max-budget-usd'), '2', 'its own cost limit');
    assert.match(call.prompt, /^\[Review Desk: summary\]/);
    assert.match(call.prompt, /Files changed \(4\)/);
    assert.match(call.prompt, /## test\/auth\/session\.test\.ts/);
    assert.strictEqual(api.controller.review!.session!.id, session, 'explaining session kept');

    const state = panelState()!;
    assert.strictEqual(state.overviewStale, false);
    assert.strictEqual(state.files.length, 4);
    assert.strictEqual((await summaryRow()).description, '4 files');

    // Up to date: asking again just shows it.
    await vscode.commands.executeCommand('reviewDesk.summarize');
    assert.strictEqual(fakeCalls().length, calls + 1);
  });

  it('marks the summary out of date when the change moves on, and writes it again', async () => {
    fs.appendFileSync(path.join(workspace(), 'src/lib/api-client.ts'), '// later edit\n');
    try {
      await until('out of date', () => panelState()?.overviewStale === true);
      const row = await summaryRow();
      assert.strictEqual(row.description, '4 files · out of date');
      const calls = fakeCalls().length;
      // A click on the row, to look: the summary as it is, marked out of date; nothing runs.
      await vscode.commands.executeCommand(row.command!.command, ...(row.command!.arguments ?? []));
      await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual(fakeCalls().length, calls, 'looking runs nothing');
      assert.ok(!api.panel.explain.isSummarizing);
      assert.strictEqual(panelState()?.overviewStale, true);
      // Summarize Changes (the command, or Update in the panel): written again.
      await vscode.commands.executeCommand('reviewDesk.summarize');
      await until('written again', () => fakeCalls().length === calls + 1);
      assert.match(fakeCalls().at(-1)!.prompt, /later edit/);
      await until(
        'up to date',
        () => !api.panel.explain.isSummarizing && panelState()?.overviewStale === false,
      );
    } finally {
      run('checkout', '--', 'src/lib/api-client.ts');
    }
  });

  it('can cancel a summary, keeping the one before', async () => {
    const before = api.controller.review!.overview;
    process.env.FAKE_CLAUDE_SLOW = '1';
    try {
      await api.panel.receive({ type: 'summarize' });
      await until('streaming', () => !!api.panel.explain.summary?.text);
      assert.match((await summaryRow()).description as string, /writing…$/);
      await api.panel.receive({ type: 'cancelSummary' });
      assert.strictEqual(api.panel.explain.isSummarizing, false);
      assert.deepStrictEqual(lastSummary(), { type: 'summary', run: null });
      await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual(api.controller.review!.overview, before);
    } finally {
      delete process.env.FAKE_CLAUDE_SLOW;
    }
  });

  it('starts a new explaining session once the last one went idle or grew big', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const startsOver = async (from: number) => {
      const before = api.controller.review!.session!.id;
      const id = await explain('src/auth/refresh.ts', from);
      await until('explained', () => card(id)?.pending === undefined);
      const call = fakeCalls().at(-1)!;
      assert.strictEqual(argAfter(call.args, '--resume'), undefined, 'a new session');
      assert.match(call.prompt, /Files changed in this review \(4\)/);
      assert.match(call.prompt, /Diff of src\/auth\/refresh\.ts/);
      assert.notStrictEqual(api.controller.review!.session!.id, before);
    };

    api.controller.mutate((r) => {
      r.session!.usedAt = tenMinutesAgo;
    });
    await startsOver(3);
    api.controller.mutate((r) => {
      r.session!.tokens = 150_000;
    });
    await startsOver(5);
  });

  it('answers on a note in a new session once its conversation went idle', async () => {
    const first = api.controller.resolved.find((a) => a.resolvedStart === 8)!;
    const old = first.threadSession!;
    api.controller.mutate((r) => {
      const a = r.annotations.find((x) => x.id === first.id)!;
      for (const m of a.thread!) m.at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    });
    await api.panel.receive({
      type: 'ask',
      cardId: first.id,
      text: 'Again?',
      useSelection: false,
    });
    await until('answered', () => card(first.id)?.thread?.length === 4);
    const call = fakeCalls().at(-1)!;
    assert.strictEqual(argAfter(call.args, '--resume'), undefined, 'a new session');
    assert.match(call.prompt, /The change \(line numbers/, 'with the diff');
    assert.match(call.prompt, /Earlier conversation on this note:\nReviewer: How do we stop it\?/);
    assert.notStrictEqual(card(first.id)!.threadSession, old);
    assert.strictEqual(card(first.id)!.threadTokens, 1000);
  });

  it('summarizes a whole file as a note on the file, written again once the file changes', async () => {
    const calls = fakeCalls().length;
    // As from the Review list: the file row.
    const id = await vscode.commands.executeCommand<string>('reviewDesk.summarizeFile', {
      kind: 'file',
      path: 'src/auth/session.ts',
    });
    assert.ok(id);
    await until('summarized', () => card(id)?.pending === undefined && !!card(id)?.body);
    const note = card(id)!;
    assert.deepStrictEqual(
      [note.kind, note.title, note.file, note.startLine, note.state],
      ['overview', 'Refreshes expired tokens in place', 'src/auth/session.ts', 0, 'ok'],
    );
    assert.ok(note.anchorText, 'remembers the version of the file');
    assert.strictEqual(api.panel.activeId, id);
    const call = fakeCalls().at(-1)!;
    assert.strictEqual(fakeCalls().length, calls + 1);
    assert.match(call.prompt, /^\[Review Desk: file summary\]/);
    assert.match(call.prompt, /summary of the file src\/auth\/session\.ts/);
    // No line badge in the editor for a note on the whole file.
    const editor = await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(workspace(), 'src/auth/session.ts')),
      { viewColumn: vscode.ViewColumn.One, preview: false },
    );
    const uri = editor.document.uri.toString();
    const lineNotes = api.controller.resolved.filter(
      (a) => a.file === 'src/auth/session.ts' && a.startLine > 0,
    ).length;
    await until('badges', () => api.controller.decorator.applied.get(uri) === lineNotes);

    // Current: asking again shows the same note.
    assert.strictEqual(
      await vscode.commands.executeCommand('reviewDesk.summarizeFile', editor.document.uri),
      id,
    );
    assert.strictEqual(fakeCalls().length, calls + 1);

    const file = path.join(workspace(), 'src/auth/session.ts');
    fs.appendFileSync(file, '// later edit\n');
    try {
      await until('outdated', () => card(id)?.state === 'stale');
      await api.panel.receive({ type: 'summarizeFile', file: 'src/auth/session.ts' });
      await until('written again', () => card(id)?.state === 'ok' && !card(id)?.pending);
      assert.strictEqual(fakeCalls().length, calls + 2);
      assert.match(fakeCalls().at(-1)!.prompt, /later edit/);
    } finally {
      run('checkout', '--', 'src/auth/session.ts');
    }
  });

  it('summarizes an unchanged file, and answers questions on the note', async () => {
    const id = await vscode.commands.executeCommand<string>(
      'reviewDesk.summarizeFile',
      vscode.Uri.file(path.join(workspace(), 'src/auth/token.ts')),
    );
    await until('summarized', () => card(id)?.pending === undefined && !!card(id)?.body);
    assert.match(fakeCalls().at(-1)!.prompt, /src\/auth\/token\.ts did not change in this review/);

    await api.panel.receive({ type: 'ask', cardId: id, text: 'Why?', useSelection: false });
    await until('answered', () => card(id)?.thread?.length === 2);
    assert.match(fakeCalls().at(-1)!.prompt, /\(Overview · src\/auth\/token\.ts, the whole file\)/);
  });

  it('shows the section of a file picked in the list, and summarizes it from there', async () => {
    const lastCurrent = () => posted.filter((m) => m.type === 'currentFile').at(-1);
    await vscode.commands.executeCommand('reviewDesk.openFile', 'src/lib/api-client.ts');
    assert.ok(api.panel.host.isOpen);
    assert.strictEqual(api.panel.currentFile, 'src/lib/api-client.ts');
    assert.deepStrictEqual(lastCurrent(), {
      type: 'currentFile',
      file: 'src/lib/api-client.ts',
      focus: true,
    });

    await api.panel.receive({ type: 'summarizeFile', file: 'src/lib/api-client.ts' });
    const note = () =>
      api.controller.resolved.find((a) => a.file === 'src/lib/api-client.ts' && a.startLine === 0);
    await until('summarized', () => !!note() && !note()!.pending);
    assert.strictEqual(api.panel.activeId, note()!.id, 'the new note is opened');

    // Another file in front moves the section there (without scrolling to it).
    await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(workspace(), 'src/auth/refresh.ts')),
      { viewColumn: vscode.ViewColumn.One, preview: false },
    );
    await until('follows the editor', () => api.panel.currentFile === 'src/auth/refresh.ts');
    assert.deepStrictEqual(lastCurrent(), {
      type: 'currentFile',
      file: 'src/auth/refresh.ts',
      focus: false,
    });
  });
});
