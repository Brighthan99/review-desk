import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { ActiveFileInfo, PanelState, ToPanel } from '../../src/shared/protocol';
import { activate, answering, argAfter, fakeCalls, freshBranch, until, workspace } from './helpers';

describe('panel (M2)', () => {
  let api: ExtensionApi;
  const posted: ToPanel[] = [];
  const lastState = (): PanelState | null | undefined =>
    [...posted].reverse().find((m): m is Extract<ToPanel, { type: 'state' }> => m.type === 'state')
      ?.state;
  const answers = (cardId: string) =>
    posted.filter(
      (m): m is Extract<ToPanel, { type: 'answer' }> => m.type === 'answer' && m.cardId === cardId,
    );
  const card = (id: string) => api.controller.resolved.find((a) => a.id === id);

  before(async () => {
    const ext = vscode.extensions.getExtension<ExtensionApi>('brighthan99.review-desk')!;
    api = await activate();
    await freshBranch(api, 'it-panel');
    await vscode.workspace
      .getConfiguration('reviewDesk')
      .update(
        'claudePath',
        path.join(ext.extensionPath, 'test', 'fixtures', 'fake-claude.mjs'),
        vscode.ConfigurationTarget.Global,
      );
    api.panel.host.onDidPost((m) => posted.push(m));
  });

  after(async () => {
    // Leave the head without a review so other suites start clean.
    const t = api.controller.target!;
    fs.rmSync(api.controller.store!.reviewPath(t.head.sha), { force: true });
    await vscode.workspace
      .getConfiguration('reviewDesk')
      .update('claudePath', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('opens the panel when a review starts and the webview loads', async () => {
    assert.ok(await vscode.commands.executeCommand('reviewDesk.start', { base: 'main' }));
    await until('panel ready', () => api.panel.host.isReady, 20000);
    assert.strictEqual(lastState()?.cards.length, 0);
  });

  it('shows the review as cards in reading order', async () => {
    const t = api.controller.target!;
    const review = {
      version: 1,
      base: t.base,
      head: t.head,
      session: { agent: 'claude-code', id: 'explain-session', usedAt: new Date().toISOString() },
      status: 'done',
      overview: 'The server refreshes the token.',
      annotations: [
        {
          id: 'a3',
          file: 'src/lib/api-client.ts',
          startLine: 4,
          endLine: 4,
          anchorText: 'return get(url);',
          kind: 'why',
          title: 'Retry removed',
          body: 'Since the server refreshes',
          group: 'Client cleanup',
          order: 3,
        },
        {
          id: 'a1',
          file: 'src/auth/session.ts',
          startLine: 6,
          endLine: 6,
          anchorText: 'const token = req.cookies.token ?? readBearer(req);',
          kind: 'why',
          title: 'Header token',
          body: 'Mobile apps',
          group: 'Token refresh',
          order: 1,
        },
        {
          id: 'a2',
          file: 'src/auth/session.ts',
          startLine: 8,
          endLine: 13,
          anchorText: 'if (isExpired(token)) {',
          kind: 'how',
          title: 'Refresh in place',
          body: 'One request fewer.',
          group: 'Token refresh',
          order: 2,
        },
      ],
    };
    fs.writeFileSync(api.controller.store!.reviewPath(t.head.sha), JSON.stringify(review));
    await until('three cards', () => lastState()?.cards.length === 3);
    const s = lastState()!;
    assert.strictEqual(s.overview, 'The server refreshes the token.');
    assert.deepStrictEqual(
      s.cards.map((c) => [c.number, c.id, c.kindLabel, c.group]),
      [
        [1, 'a1', 'Why', 'Token refresh'],
        [2, 'a2', 'How', 'Token refresh'],
        [3, 'a3', 'Why', 'Client cleanup'],
      ],
    );
  });

  it('selecting a card reveals its lines and highlights them', async () => {
    await api.panel.receive({ type: 'select', id: 'a2' });
    assert.strictEqual(api.panel.activeId, 'a2');
    const session = path.join(workspace(), 'src/auth/session.ts');
    await until('session.ts showing line 8', () =>
      vscode.window.visibleTextEditors.some(
        (e) =>
          e.document.uri.fsPath === session &&
          e.visibleRanges.some((r) => r.contains(new vscode.Position(7, 0))),
      ),
    );
    assert.ok(posted.some((m) => m.type === 'focus' && m.id === 'a2'));
  });

  it('closes the open card, which scrolling over its code does not open again', async () => {
    const session = path.join(workspace(), 'src/auth/session.ts');
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === session)!;
    // Past the pause after revealing a card's code; the card the editor would pick is open.
    await new Promise((r) => setTimeout(r, 900));
    api.panel.focusFromEditor(editor);
    const open = api.panel.activeId!;
    assert.ok(open);
    await api.panel.receive({ type: 'close', id: open });
    assert.strictEqual(api.panel.activeId, undefined);
    assert.deepStrictEqual(posted[posted.length - 1], { type: 'focus', id: null });
    api.panel.focusFromEditor(editor);
    assert.strictEqual(api.panel.activeId, undefined, 'still closed');
    await api.panel.receive({ type: 'select', id: open });
    assert.strictEqual(api.panel.activeId, open, 'opens again when picked');
  });

  it('opens code on the left, as the file itself, with the notes kept on the right', async () => {
    // As when the panel was opened with no editor: it sits in the first group.
    await api.panel.host.moveTo(vscode.ViewColumn.One);
    await until(
      'panel in the first group',
      () => api.panel.host.viewColumn === vscode.ViewColumn.One,
    );
    await api.panel.receive({ type: 'select', id: 'a3' });
    await until('panel moved right', () => api.panel.host.viewColumn === vscode.ViewColumn.Two);
    const file = path.join(workspace(), 'src/lib/api-client.ts');
    await until('code on the left', () =>
      vscode.window.visibleTextEditors.some(
        (e) => e.document.uri.fsPath === file && e.viewColumn === vscode.ViewColumn.One,
      ),
    );
    const left = vscode.window.tabGroups.all.find((g) => g.viewColumn === vscode.ViewColumn.One);
    assert.ok(left?.activeTab?.input instanceof vscode.TabInputText, 'the file, not a diff');
  });

  it('changes the answer language from the panel header, offering to translate the notes', async () => {
    assert.strictEqual(lastState()?.language, 'English');
    const asked: { message: string; buttons: string[] }[] = [];
    const restore = answering(api, {
      choose: async (message, buttons) => (asked.push({ message, buttons }), undefined),
    });
    try {
      assert.strictEqual(
        await vscode.commands.executeCommand('reviewDesk.changeLanguage', 'Japanese'),
        'Japanese',
      );
      // Notes written before the language was kept count as not in it; not translated here.
      await until('asked', () => asked.length > 0);
      assert.strictEqual(
        asked[0].message,
        'Translate the summary and 3 notes of this review into Japanese?',
      );
      assert.deepStrictEqual(asked[0].buttons, ['Translate']);
      assert.strictEqual(
        vscode.workspace.getConfiguration('reviewDesk').get('language'),
        'Japanese',
      );
      await until('header shows it', () => lastState()?.language === 'Japanese');
      assert.ok(lastState()?.cards.find((c) => c.id === 'a1')?.translatable, 'a button on it');
    } finally {
      restore();
      await vscode.workspace
        .getConfiguration('reviewDesk')
        .update('language', undefined, vscode.ConfigurationTarget.Global);
    }
    await until('back to English', () => lastState()?.language === 'English');
  });

  it('marks a card as understood', async () => {
    await api.panel.receive({ type: 'understood', id: 'a1', value: true });
    await until('understood', () => card('a1')?.understood === true);
    assert.strictEqual(lastState()?.cards.find((c) => c.id === 'a1')?.understood, true);
  });

  it('lists changed files by folder and cards by reading order', async () => {
    const rows = async () => (await api.tree.getChildren()).map((n) => api.tree.getTreeItem(n));
    // The first rows are the folder and branch, what the review compares with and its
    // summary; then the list.
    const labels = async () => (await rows()).slice(3).map((i) => String(i.label));
    const [where, base, summary] = await rows();
    assert.strictEqual(where.id, 'where');
    assert.match(String(base.label), /^main ↔ /, 'the base first, as diffs show it');
    assert.strictEqual(base.command?.command, 'reviewDesk.compare');
    assert.strictEqual(summary.label, 'Summary of Changes');
    assert.strictEqual(summary.command?.command, 'reviewDesk.summarize');
    assert.deepStrictEqual(summary.command?.arguments, ['show'], 'a click shows, never rewrites');
    assert.deepStrictEqual(await labels(), ['src', 'test/auth']);
    api.tree.setMode('order');
    assert.deepStrictEqual(await labels(), ['1. Token refresh', '2. Client cleanup']);
    api.tree.setMode('folder');
    api.tree.setShowAll(true);
    assert.deepStrictEqual(await labels(), ['src', 'test/auth', 'README.md', 'package.json']);
    api.tree.setShowAll(false);
  });

  it('shows explanation counts on Explorer files', () => {
    const uri = vscode.Uri.file(path.join(workspace(), 'src/auth/session.ts'));
    assert.strictEqual(api.badges.provideFileDecoration(uri)?.badge, '2');
    assert.strictEqual(
      api.badges.provideFileDecoration(vscode.Uri.file(path.join(workspace(), 'README.md'))),
      undefined,
    );
  });

  it('answers a card question by forking the explaining session, then continues the fork', async () => {
    await api.panel.receive({
      type: 'ask',
      cardId: 'a2',
      text: 'Is it called twice at once?',
      useSelection: false,
    });
    await until('answer saved', () => card('a2')?.thread?.length === 2);
    const a2 = card('a2')!;
    assert.deepStrictEqual(
      a2.thread!.map((m) => m.from),
      ['user', 'ai'],
    );
    assert.strictEqual(a2.thread![1].body, 'Yes. Each request calls `refresh` on its own.');
    assert.match(a2.threadSession!, /^fork-/);
    assert.ok(answers('a2').length > 2, 'answer streamed in pieces');

    const first = fakeCalls().at(-1)!;
    assert.strictEqual(argAfter(first.args, '--resume'), 'explain-session');
    assert.ok(first.args.includes('--fork-session'));
    assert.strictEqual(argAfter(first.args, '--tools'), 'Read,Grep,Glob');
    assert.strictEqual(argAfter(first.args, '--max-budget-usd'), '0.5');
    assert.match(first.prompt, /Note 2\. Refresh in place \(How · src\/auth\/session\.ts 8–13\)/);
    assert.match(first.prompt, /Question: Is it called twice at once\?/);

    await api.panel.receive({
      type: 'ask',
      cardId: 'a2',
      text: 'Then how do we stop it?',
      useSelection: false,
    });
    await until('second answer', () => card('a2')?.thread?.length === 4);
    const second = fakeCalls().at(-1)!;
    assert.strictEqual(argAfter(second.args, '--resume'), a2.threadSession);
    assert.ok(!second.args.includes('--fork-session'));
    assert.match(second.prompt, /Reviewer: Is it called twice at once\?/);

    await vscode.workspace
      .getConfiguration('reviewDesk')
      .update('language', 'Korean', vscode.ConfigurationTarget.Global);
    try {
      await api.panel.receive({
        type: 'ask',
        cardId: 'a2',
        text: 'In Korean?',
        useSelection: false,
      });
      await until('answer in the configured language', () => card('a2')?.thread?.length === 6);
      assert.match(fakeCalls().at(-1)!.prompt, /in Korean, as markdown/);
    } finally {
      await vscode.workspace
        .getConfiguration('reviewDesk')
        .update('language', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("translates a note into the current language: Claude's text, not the questions", async () => {
    // a2: written before its language was kept, then answered in English and in Korean.
    const before = card('a2')!;
    assert.strictEqual(before.language, undefined, 'mixed: no one language');
    await vscode.workspace
      .getConfiguration('reviewDesk')
      .update('language', 'German', vscode.ConfigurationTarget.Global);
    try {
      await until('German', () => lastState()?.language === 'German');
      assert.ok(lastState()!.cards.find((c) => c.id === 'a2')?.translatable);
      await api.panel.receive({ type: 'translate', id: 'a2' });
      const after = card('a2')!;
      assert.strictEqual(after.title, `(German) ${before.title}`);
      assert.strictEqual(after.body, `(German) ${before.body}`);
      assert.deepStrictEqual(
        after.thread!.map((m) => m.body),
        before.thread!.map((m) => (m.from === 'ai' ? `(German) ${m.body}` : m.body)),
        'the answers translated, the questions as asked',
      );
      assert.strictEqual(after.language, 'German');

      // The summary too: its text (no diagram or reading order in this one).
      assert.ok(lastState()!.overviewTranslatable);
      const summary = api.controller.review!.overview!;
      await api.panel.receive({ type: 'translate', id: '#summary' });
      assert.strictEqual(api.controller.review!.overview, `(German) ${summary}`);
      assert.strictEqual(api.controller.review!.overviewLanguage, 'German');
      await until('no summary button once in German', () => !lastState()!.overviewTranslatable);
      await until('no button once in German', () =>
        lastState()!.cards.some((c) => c.id === 'a2' && !c.translatable),
      );
      assert.ok(posted.some((m) => m.type === 'translation' && m.cardId === 'a2' && m.running));
      // A short run of its own: no tools, no session.
      const call = fakeCalls().at(-1)!;
      assert.match(
        call.prompt,
        /^\[Review Desk: translate\]\nTranslate the texts below into German\./,
      );
      assert.strictEqual(argAfter(call.args, '--tools'), '');
      assert.ok(!call.args.includes('--resume'));
    } finally {
      await vscode.workspace
        .getConfiguration('reviewDesk')
        .update('language', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('opens a new question card at once, while Claude is still reading the code', async () => {
    const before = new Set(api.controller.resolved.map((a) => a.id));
    // [slow]: the fake claude takes its time, as one reading files does.
    const asking = api.panel.receive({
      type: 'ask',
      cardId: null,
      text: '[slow] What does this file do?',
      useSelection: false,
      file: 'src/auth/session.ts',
    });
    await until('the new card open', () => !!api.panel.activeId && !before.has(api.panel.activeId));
    const id = api.panel.activeId!;
    assert.ok(
      posted.some((m) => m.type === 'focus' && m.id === id),
      'the panel told',
    );
    assert.ok(!answers(id).some((a) => a.done), 'before the answer is done');
    await asking;
    assert.ok(
      answers(id).some((a) => a.done && !a.error),
      'then answered',
    );
    await until('answer saved', () => card(id)?.thread?.length === 2);
    // Gone again: the next tests look for the question card they make.
    await api.panel.receive({ type: 'remove', id });
    await until('removed', () => !card(id));
  });

  it('asks about the selected code from the bottom box as a new question card', async () => {
    const editor = await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(workspace(), 'src/auth/session.ts')),
      {
        viewColumn: vscode.ViewColumn.One,
      },
    );
    editor.selection = new vscode.Selection(16, 0, 18, 999);
    await until(
      'selection tracked',
      () => api.panel.selection?.startLine === 17 && api.panel.selection.endLine === 19,
    );
    await api.panel.receive({
      type: 'ask',
      cardId: null,
      text: 'Why use replace?',
      useSelection: true,
    });
    await until('question card answered', () =>
      api.controller.resolved.some((a) => a.kind === 'question' && a.thread?.length === 2),
    );
    const q = api.controller.resolved.find((a) => a.kind === 'question')!;
    assert.deepStrictEqual(
      [q.file, q.startLine, q.endLine, q.title],
      ['src/auth/session.ts', 17, 19, 'Why use replace?'],
    );
    assert.strictEqual(api.panel.activeId, q.id);
    assert.match(
      fakeCalls().at(-1)!.prompt,
      /Code the reviewer selected: src\/auth\/session\.ts 17–19/,
    );
  });

  it('asks about the current file from the bottom box when nothing is selected', async () => {
    await api.panel.receive({
      type: 'ask',
      cardId: null,
      text: 'What is this file for?',
      useSelection: false,
      file: 'src/lib/api-client.ts',
    });
    await until('file question answered', () =>
      api.controller.resolved.some(
        (a) =>
          a.file === 'src/lib/api-client.ts' && a.kind === 'question' && a.thread?.length === 2,
      ),
    );
    const q = api.controller.resolved.find(
      (a) => a.file === 'src/lib/api-client.ts' && a.kind === 'question',
    )!;
    assert.deepStrictEqual([q.startLine, q.endLine, q.state], [0, 0, 'ok']);
    assert.strictEqual(api.panel.activeId, q.id);
    assert.match(
      fakeCalls().at(-1)!.prompt,
      /Code in question: src\/lib\/api-client\.ts, the whole file/,
    );
  });

  it('cancels a running answer and reports agent errors', async () => {
    void api.panel.receive({
      type: 'ask',
      cardId: 'a3',
      text: '[slow] Please answer slowly',
      useSelection: false,
    });
    await until('streaming started', () => answers('a3').some((m) => !m.done && m.text.length > 0));
    await api.panel.receive({ type: 'cancel', cardId: 'a3' });
    await until('cancelled', () => answers('a3').some((m) => m.done && m.error === 'Cancelled.'));
    assert.strictEqual(card('a3')?.thread?.length, 1, 'only the question is kept');

    await api.panel.receive({ type: 'ask', cardId: 'a1', text: '[fail]', useSelection: false });
    await until('error', () =>
      answers('a1').some(
        (m) =>
          m.done &&
          m.error ===
            'Stopped at the cost limit of $0.50 before finishing. To allow more, raise reviewDesk.maxBudgetUsd in the settings and try again.',
      ),
    );
  });

  it('follows an unchanged file and comes back', async () => {
    const activeFile = () =>
      [...posted]
        .reverse()
        .find((m): m is Extract<ToPanel, { type: 'activeFile' }> => m.type === 'activeFile')?.info;
    await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(workspace(), 'src/auth/token.ts')),
      {
        viewColumn: vscode.ViewColumn.One,
      },
    );
    await until('file view', () => activeFile()?.file === 'src/auth/token.ts');
    await until('uses computed', () => activeFile()?.uses !== 'loading', 30000);
    console.log('      uses of token.ts:', JSON.stringify((activeFile() as ActiveFileInfo).uses));

    await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(workspace(), 'src/auth/session.ts')),
      {
        viewColumn: vscode.ViewColumn.One,
      },
    );
    await until('back to review', () => activeFile() === null);
  });
});
