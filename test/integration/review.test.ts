import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { DimmedRows } from '../../src/ui/comparisonRows';
import { activate, freshBranch, run, topRow, until, workspace } from './helpers';

describe('review (M1)', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-review');
    await vscode.workspace
      .getConfiguration('reviewDesk')
      .update('showCommentThreads', true, vscode.ConfigurationTarget.Global);
  });

  after(async () => {
    await vscode.workspace
      .getConfiguration('reviewDesk')
      .update('showCommentThreads', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('starts a review: an empty review in the git dir, the changes editor open', async () => {
    const ok = await vscode.commands.executeCommand<boolean>('reviewDesk.start', { base: 'main' });
    assert.strictEqual(ok, true);
    const { target, store } = api.controller;
    assert.ok(target && store);
    assert.strictEqual(target.head.ref, 'it-review');
    assert.strictEqual(target.files.length, 4);

    assert.ok(fs.existsSync(store.reviewPath(target.head.sha)));
    assert.strictEqual(run('status', '--porcelain'), '', 'nothing in the working tree');
    assert.deepStrictEqual(api.controller.review?.annotations, []);

    await until('changes editor tab', () =>
      vscode.window.tabGroups.all.some((g) =>
        g.tabs.some((t) => /^Review: .+ ↔ it-review/.test(t.label)),
      ),
    );
    // Prototype check: are the editors inside the multi-file diff editor visible to extensions?
    console.log(
      '      visible editors with changes editor open:',
      vscode.window.visibleTextEditors.map(
        (e) => `${e.document.uri.scheme}:${path.basename(e.document.uri.fsPath)}`,
      ),
    );
  });

  it('loads annotations from the review file and resolves their anchors', async () => {
    const { target } = api.controller;
    const review = {
      version: 1,
      base: target!.base,
      head: target!.head,
      session: { agent: 'claude-code', id: 'session-1' },
      status: 'done',
      overview: 'Refresh on the server.',
      annotations: [
        {
          id: 'a1',
          file: 'src/auth/session.ts',
          startLine: 6,
          endLine: 6,
          anchorText: 'const token = req.cookies.token ?? readBearer(req);',
          kind: 'why',
          title: 'Bearer token',
          body: 'Mobile apps.',
          order: 1,
        },
        {
          id: 'a2',
          file: 'src/auth/session.ts',
          startLine: 10,
          endLine: 15,
          anchorText: 'if (isExpired(token)) {',
          kind: 'how',
          title: 'Refresh inline',
          body: 'Saves a round trip.',
          order: 2,
        },
        {
          id: 'a3',
          file: 'src/auth/session.ts',
          startLine: 2,
          endLine: 2,
          anchorText: 'nothing like this',
          kind: 'risk',
          title: 'Stale',
          body: '',
          order: 3,
        },
        {
          id: 'a4',
          file: 'src/auth/session.ts',
          side: 'old',
          startLine: 5,
          endLine: 5,
          anchorText: 'const token = req.cookies.token;',
          kind: 'why',
          title: 'Old cookie read',
          body: '',
          order: 4,
        },
      ],
    };
    fs.writeFileSync(api.controller.store!.reviewPath(target!.head.sha), JSON.stringify(review));
    await until('annotations', () => api.controller.resolved.length === 4);

    assert.deepStrictEqual(
      api.controller.resolved.map((a) => [a.id, a.number, a.state, a.resolvedStart, a.resolvedEnd]),
      [
        ['a1', 1, 'ok', 6, 6],
        ['a2', 2, 'moved', 8, 13],
        ['a3', 3, 'stale', 2, 2],
        ['a4', 4, 'ok', 5, 5],
      ],
    );
    assert.strictEqual(api.controller.comments.count, 4);
  });

  it('decorates the working tree file with the new-side annotations', async () => {
    const file = vscode.Uri.file(path.join(workspace(), 'src/auth/session.ts'));
    await vscode.window.showTextDocument(file, { preview: false });
    await until('decorations', () => api.controller.decorator.applied.get(file.toString()) === 3);
  });

  it('reports an invalid review file and keeps the last good review', async () => {
    const { target } = api.controller;
    fs.writeFileSync(api.controller.store!.reviewPath(target!.head.sha), '{ "version": 1, ');
    await until('load error', () => api.controller.loadError !== undefined);
    assert.strictEqual(api.controller.resolved.length, 4);
  });

  it('follows HEAD to a new commit and carries the annotations over', async () => {
    const { target, store } = api.controller;
    const good = {
      version: 1,
      base: target!.base,
      head: target!.head,
      status: 'done',
      annotations: [
        {
          id: 'a2',
          file: 'src/auth/session.ts',
          startLine: 8,
          endLine: 13,
          anchorText: 'if (isExpired(token)) {',
          kind: 'how',
          title: 'Refresh inline',
          body: '',
        },
      ],
    };
    fs.writeFileSync(api.controller.store!.reviewPath(target!.head.sha), JSON.stringify(good));
    await until(
      'fixed review',
      () => api.controller.loadError === undefined && api.controller.resolved.length === 1,
    );

    const sessionFile = path.join(workspace(), 'src/auth/session.ts');
    const lines = fs.readFileSync(sessionFile, 'utf8').split('\n');
    lines.splice(2, 0, '// a new line pushes everything down', '');
    fs.writeFileSync(sessionFile, lines.join('\n'));
    run('commit', '-q', '-am', 'Push lines down');
    const newHead = run('rev-parse', 'HEAD');

    await until('new head', () => api.controller.target?.head.sha === newHead, 15000);
    await until(
      'carried annotation re-resolved',
      () => api.controller.resolved[0]?.state === 'moved',
    );
    const [a] = api.controller.resolved;
    assert.deepStrictEqual([a.state, a.resolvedStart, a.resolvedEnd], ['moved', 10, 15]);
    assert.ok(fs.existsSync(store!.reviewPath(target!.head.sha)), 'previous review is kept');
  });

  it('changes the base during a review and keeps it for the next start', async () => {
    const head = api.controller.target!.head.sha;
    const storedBase = () => {
      const r = api.controller.store!.load(head);
      return r.kind === 'ok' ? r.review.base.ref : undefined;
    };
    assert.ok(await vscode.commands.executeCommand('reviewDesk.changeBase', 'HEAD'));
    await until('base HEAD', () => api.controller.target?.base.ref === 'HEAD');
    assert.deepStrictEqual(api.controller.target!.files, [], 'only uncommitted changes: none');
    assert.strictEqual(storedBase(), 'HEAD', 'kept in the review file');
    assert.strictEqual(api.controller.resolved.length, 1, 'notes stay');

    assert.ok(await vscode.commands.executeCommand('reviewDesk.changeBase', 'main'));
    await until('base main', () => storedBase() === 'main');
  });

  it('draws the comparison as a branch whose ends change the sides, and moves the base', async () => {
    const base = (await topRow(api, 'base'))!;
    const nodes = await api.tree.getChildren(base);
    const rows = nodes.map((n) => api.tree.getTreeItem(n));
    const label = (i: vscode.TreeItem) =>
      typeof i.label === 'string' ? i.label : (i.label as vscode.TreeItemLabel).label;
    // The compare end on top: HEAD (nothing uncommitted); clicking it changes the compare side.
    const head = rows[0];
    assert.match(label(head), /^compare: [0-9a-f]{7} Push lines down$/, 'HEAD is the compare side');
    assert.deepStrictEqual((head.label as vscode.TreeItemLabel).highlights, [[0, 8]]);
    assert.match(String(head.description), /HEAD · it-review · change…$/);
    assert.strictEqual(head.contextValue, 'historyHead', 'already the compare side');
    assert.strictEqual(head.command?.command, 'reviewDesk.changeRight');
    // Commits in between: no side; clicking one offers to make it a side.
    assert.doesNotMatch(label(rows[1]), /^(base|compare): /);
    assert.strictEqual(rows[1].command?.command, 'reviewDesk.commitActions');
    // The base end; then the row that opens every base to pick from.
    const left = rows.find((r) => r.contextValue === 'historyBase')!;
    assert.match(label(left), /^base: /);
    assert.doesNotMatch(String(left.description), /\bbase\b/, 'the label says it already');
    assert.match(String(left.description), /main · change…$/);
    assert.strictEqual(left.command?.command, 'reviewDesk.changeBase');
    assert.strictEqual(label(rows.at(-1)!), 'Older commits, branches, tags…');

    // Moved forward, the base keeps the commits before it in reach.
    const headSha = run('rev-parse', 'HEAD');
    await vscode.commands.executeCommand('reviewDesk.compareFrom', { row: { sha: headSha } });
    await until('base is HEAD', () => api.controller.target?.base.sha === headSha);
    const moved = (await api.tree.getChildren((await topRow(api, 'base'))!)).map((n) =>
      api.tree.getTreeItem(n),
    );
    const earlier = moved.filter((r) => r.contextValue === 'historyEarlier');
    assert.ok(earlier.length > 0, 'commits before the base are listed');
    assert.match(String(earlier[0].description), /earlier · not compared$/);
    // Faded, label too: the row's resource carries the faded color.
    const uri = earlier[0].resourceUri!;
    assert.strictEqual(uri.scheme, 'review-desk-dimmed');
    const decoration = new DimmedRows().provideFileDecoration(uri);
    assert.strictEqual(
      (decoration?.color as vscode.ThemeColor | undefined)?.id,
      'disabledForeground',
    );
    const previous = run('rev-parse', 'HEAD~1');
    assert.ok(
      await vscode.commands.executeCommand(
        'reviewDesk.commitActions',
        earlier[0].command!.arguments![0],
        'left',
      ),
    );
    await until('base moved back', () => api.controller.target?.base.sha === previous);
    assert.ok(await vscode.commands.executeCommand('reviewDesk.changeBase', 'main'));
  });

  it('defaults to the PR target on record, then to the last review’s base', async () => {
    const start = () => vscode.commands.executeCommand('reviewDesk.start', { open: false });
    // No record: the last review of this branch (against main).
    await vscode.commands.executeCommand('reviewDesk.closeReview');
    assert.ok(await start());
    assert.strictEqual(api.controller.baseChoice?.source, 'last-review');
    assert.strictEqual(api.controller.target!.base.ref, 'main');

    // Picked with the pin: remembered as this branch's PR target, as gh does.
    assert.ok(await vscode.commands.executeCommand('reviewDesk.changeBase', 'feat/rename', true));
    assert.strictEqual(run('config', '--get', 'branch.it-review.gh-merge-base'), 'feat/rename');
    await vscode.commands.executeCommand('reviewDesk.closeReview');
    assert.ok(await start());
    assert.deepStrictEqual(api.controller.baseChoice, {
      ref: 'feat/rename',
      source: 'gh-merge-base',
      detail: 'feat/rename',
    });
    const baseRow = (await topRow(api, 'base'))!;
    assert.match(String(api.tree.getTreeItem(baseRow).description), /PR target/);

    run('config', '--unset', 'branch.it-review.gh-merge-base');
    assert.ok(await vscode.commands.executeCommand('reviewDesk.changeBase', 'main'));
  });

  it('folds and unfolds every row that folds: Collapse All, Expand All (in the menu)', async () => {
    const folding = async () =>
      (await api.tree.getChildren())
        .map((n) => api.tree.getTreeItem(n))
        .filter((i) => i.collapsibleState !== vscode.TreeItemCollapsibleState.None);
    const before = await folding();
    const ids = before.map((i) => i.id!);
    assert.ok(ids.includes('base') && ids.some((id) => id.startsWith('folder:')), ids.join());
    assert.ok(before.every((i) => i.collapsibleState === vscode.TreeItemCollapsibleState.Expanded));

    // New ids each time: VS Code forgets how they were folded and shows them as they start.
    await vscode.commands.executeCommand('reviewDesk.tree.collapseAll');
    const folded = await folding();
    assert.deepStrictEqual(
      folded.map((i) => i.id!.replace(/#\d+$/, '')),
      ids,
    );
    assert.ok(folded.every((i, n) => i.id !== ids[n]));
    assert.ok(
      folded.every((i) => i.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed),
    );

    await vscode.commands.executeCommand('reviewDesk.tree.expandAll');
    const unfolded = await folding();
    assert.ok(unfolded.every((i, n) => i.id !== folded[n].id));
    assert.ok(
      unfolded.every((i) => i.collapsibleState === vscode.TreeItemCollapsibleState.Expanded),
    );
    assert.ok(await topRow(api, 'base'), 'still found by its id');
  });

  it('closes the review, keeping its file', async () => {
    const { store, target } = api.controller;
    await vscode.commands.executeCommand('reviewDesk.closeReview');
    assert.strictEqual(api.controller.target, undefined);
    // The list shows the branch again, and ways to start (see folders.test.ts).
    const ids = (await api.tree.getChildren()).map((n) => api.tree.getTreeItem(n).id);
    assert.deepStrictEqual(ids.slice(1), ['action:start', 'action:startWithBase', 'action:openPr']);
    assert.ok(fs.existsSync(store!.reviewPath(target!.head.sha)));
  });
});
