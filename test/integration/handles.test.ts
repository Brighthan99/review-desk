import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { changeBlocks, type ChangeBlock } from '../../src/review/blocks';
import { filePath } from '../../src/review/diffParser';
import { activate, freshBranch, run, until, useFakeClaude, workspace } from './helpers';

describe('change handles and uncommitted changes', () => {
  let api: ExtensionApi;
  let uri: vscode.Uri;
  let blocks: ChangeBlock[];

  const ourLenses = async () =>
    (
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        uri,
      )) ?? []
    ).filter((l) => l.command?.command.startsWith('reviewDesk.'));
  const card = (start: number) =>
    api.controller.resolved.find(
      (a) => a.file === 'src/auth/session.ts' && a.resolvedStart === start,
    );

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-handles');
    await useFakeClaude(true);
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
    uri = vscode.Uri.file(path.join(workspace(), 'src/auth/session.ts'));
    // CodeLenses are asked of loaded documents only (as in an editor).
    await vscode.workspace.openTextDocument(uri);
    const file = api.controller.target!.files.find((f) => filePath(f) === 'src/auth/session.ts')!;
    blocks = changeBlocks(file);
    assert.ok(blocks.length >= 2, 'session.ts has several changed blocks');
  });

  after(async () => {
    fs.rmSync(path.join(workspace(), 'NOTES.md'), { force: true });
    run('checkout', '--', '.');
    await useFakeClaude(false);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('puts Explain · Ask · Comment · Diff above each changed block', async () => {
    const lenses = await ourLenses();
    assert.deepStrictEqual(
      lenses.map((l) => [l.range.start.line + 1, l.command!.title]),
      blocks.flatMap((b) => [
        [b.newStart, '$(review-desk-logo) Explain'],
        [b.newStart, 'Ask'],
        [b.newStart, 'Comment'],
        [b.newStart, 'Diff'],
      ]),
    );
    const b = blocks[0];
    assert.deepStrictEqual(lenses[0].command!.arguments, [uri.toString(), b.start, b.end, b.side]);
  });

  it('offers the same actions, and the deleted lines, on hover', async () => {
    const b = blocks.find((x) => x.deleted.length) ?? blocks[0];
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      new vscode.Position(b.newStart - 1, 1),
    );
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
      .join('\n');
    assert.match(text, /\*\*Review Desk\*\*/);
    assert.match(text, /command:reviewDesk\.explainRange/);
    assert.match(text, /command:reviewDesk\.askAboutRange/);
    assert.match(text, /command:reviewDesk\.draftCommentRange/);
    // Every link runs: a hover runs only the commands it trusts, a link to another does nothing.
    const md = hovers.flatMap((h) => h.contents).find((c) => typeof c !== 'string') as
      vscode.MarkdownString | undefined;
    const trusted = (md?.isTrusted as { enabledCommands?: string[] } | undefined)?.enabledCommands;
    const linked = [...text.matchAll(/command:([\w.]+)/g)].map((m) => m[1]);
    assert.ok(trusted, 'trusted commands given');
    for (const c of linked) assert.ok(trusted.includes(c), `${c} runs from the hover`);
    assert.match(text, /command:reviewDesk\.summarizeFile/);
    if (b.deleted.length) assert.ok(text.includes(b.deleted[0].trim()), 'shows the deleted lines');
  });

  it('turns the file into its diff in place, and Show File turns it back', async () => {
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const active = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const tabs = () => vscode.window.tabGroups.activeTabGroup.tabs.map((t) => t.input);
    const fileTabs = () =>
      tabs().filter((t) => t instanceof vscode.TabInputText && t.uri.toString() === uri.toString());
    const diffTabs = () => tabs().filter((t) => t instanceof vscode.TabInputTextDiff);
    const onFile = () => {
      const input = active();
      return input instanceof vscode.TabInputText && input.uri.toString() === uri.toString();
    };

    const diff = (await ourLenses()).find((l) => l.command!.title === 'Diff')!;
    await vscode.commands.executeCommand(diff.command!.command, ...diff.command!.arguments!);
    await until('diff open', () => active() instanceof vscode.TabInputTextDiff);
    await until('in place of the file', () => fileTabs().length === 0);

    // The diff can be shown inline (- +) or side by side: VS Code's own diff setting.
    const sideBySide = () =>
      vscode.workspace.getConfiguration('diffEditor').get<boolean>('renderSideBySide');
    try {
      await vscode.commands.executeCommand('reviewDesk.diffInline');
      assert.strictEqual(sideBySide(), false);
      await vscode.commands.executeCommand('reviewDesk.diffSideBySide');
      assert.strictEqual(sideBySide(), true);
    } finally {
      await vscode.workspace
        .getConfiguration('diffEditor')
        .update('renderSideBySide', undefined, vscode.ConfigurationTarget.Global);
    }

    await vscode.commands.executeCommand('reviewDesk.showFile');
    await until('back on the file', onFile);
    assert.deepStrictEqual(diffTabs(), [], 'the diff is gone');

    // One toggle for both directions.
    await vscode.commands.executeCommand('reviewDesk.toggleDiff');
    await until('diff again', () => active() instanceof vscode.TabInputTextDiff);
    await vscode.commands.executeCommand('reviewDesk.toggleDiff');
    await until('file again', onFile);
  });

  it('in the diff of a file, offers Show File, and asks or comments without leaving the diff', async () => {
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const b = blocks.find((x) => x.side === 'new')!;
    await vscode.commands.executeCommand('reviewDesk.showDiff', uri, b.newStart);
    const inDiff = () =>
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff;
    await until('diff open', inDiff);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      new vscode.Position(b.newStart - 1, 1),
    );
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
      .join('\n');
    assert.match(text, /command:reviewDesk\.showFile/);
    assert.doesNotMatch(text, /command:reviewDesk\.showDiff/, 'no Diff in the diff');

    // Comment from the hover: the lines are selected in the diff, which stays in front.
    await vscode.commands.executeCommand(
      'reviewDesk.draftCommentRange',
      uri.toString(),
      b.start,
      b.end,
      b.side,
    );
    assert.ok(inDiff(), 'still the diff');
    const right = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uri.toString(),
    )!;
    assert.deepStrictEqual(
      [right.selection.start.line + 1, right.selection.end.line + 1],
      [b.start, b.end],
    );
    assert.deepStrictEqual(api.panel.composing, {
      file: 'src/auth/session.ts',
      side: 'new',
      startLine: b.start,
      endLine: b.end,
    });
    // Show File from the hover, with another group in front (as the notes panel's): this diff.
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    const link = /command:reviewDesk\.showFile\?([^)]+)\)/.exec(text)!;
    await vscode.commands.executeCommand(
      'reviewDesk.showFile',
      ...(JSON.parse(decodeURIComponent(link[1])) as unknown[]),
    );
    await until('back on the file', () =>
      vscode.window.tabGroups.all.every(
        (g) => !(g.activeTab?.input instanceof vscode.TabInputTextDiff),
      ),
    );
  });

  it('can open the diff in a tab of its own instead', async () => {
    const config = vscode.workspace.getConfiguration('reviewDesk');
    await config.update('diffOpensIn', 'newTab', vscode.ConfigurationTarget.Global);
    try {
      await vscode.window.showTextDocument(uri, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      // As the title bar button calls it: the editor's URI and a context object.
      await vscode.commands.executeCommand('reviewDesk.showDiff', uri, { groupId: 0 });
      const group = () => vscode.window.tabGroups.activeTabGroup;
      await until('diff open', () => group().activeTab?.input instanceof vscode.TabInputTextDiff);
      assert.ok(
        group().tabs.some(
          (t) =>
            t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString(),
        ),
        'the file tab stays open',
      );
      await vscode.commands.executeCommand('reviewDesk.showFile');
      await until(
        'diff closed',
        () => !group().tabs.some((t) => t.input instanceof vscode.TabInputTextDiff),
      );
    } finally {
      await config.update('diffOpensIn', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('highlights changed lines when the file is open outside the diff editor', async () => {
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    await until('highlights', () => api.handles.highlighted.get(uri.toString()) === blocks.length);
  });

  it('hints at the shortcut inside a block, which then explains the whole block', async () => {
    // A multi-line block other than the first one, which the next test explains.
    const b = blocks.filter((x) => x.side === 'new' && x.end > x.start && x !== blocks[0]).at(-1)!;
    const editor = await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    editor.selection = new vscode.Selection(b.start, 0, b.start, 0); // line b.start + 1
    await until('hint', () => api.handles.hint?.line === b.start + 1);
    assert.match(api.handles.hint!.text, /^✦ Explain this block/);

    const id = await vscode.commands.executeCommand<string>('reviewDesk.explainSelection');
    const made = () => api.controller.resolved.find((a) => a.id === id);
    await until('explained', () => made()?.pending === undefined && !!made()?.body);
    assert.deepStrictEqual([made()!.resolvedStart, made()!.resolvedEnd], [b.start, b.end]);
    await until('hint names the note', () =>
      /^✦ \d+\. May refresh twice at once/.test(api.handles.hint?.text ?? ''),
    );
  });

  it('explains a block from its handle, and the handle then shows the note', async () => {
    const [lens] = await ourLenses();
    await vscode.commands.executeCommand(lens.command!.command, ...lens.command!.arguments!);
    const b = blocks[0];
    await until('explained', () => card(b.start)?.pending === undefined && !!card(b.start)?.body);
    assert.strictEqual(card(b.start)!.resolvedEnd, b.end);
    const [first] = await ourLenses();
    assert.strictEqual(first.command!.command, 'reviewDesk.selectCard');
    assert.match(first.command!.title, /^\$\(review-desk-logo\) \d+\. May refresh twice at once/);
  });

  it("explains a change from VS Code's inline change view", async () => {
    const id = await vscode.commands.executeCommand<string>(
      'reviewDesk.explainChange',
      uri,
      [{ modifiedStartLineNumber: 17, modifiedEndLineNumber: 19 }],
      0,
    );
    assert.ok(id);
    const byId = () => api.controller.resolved.find((a) => a.id === id);
    await until('explained', () => byId()?.pending === undefined && !!byId()?.body);
    assert.deepStrictEqual([byId()!.resolvedStart, byId()!.resolvedEnd], [17, 19]);
  });

  it('includes uncommitted edits and new files, following the disk', async () => {
    const files = () => api.controller.target!.files.map(filePath);
    fs.writeFileSync(path.join(workspace(), 'NOTES.md'), 'draft\n');
    const token = path.join(workspace(), 'src/auth/token.ts');
    fs.appendFileSync(token, '// uncommitted\n');
    await until('new and edited files in the review', () =>
      ['NOTES.md', 'src/auth/token.ts'].every((f) => files().includes(f)),
    );
    assert.deepStrictEqual(api.controller.target!.uncommitted.sort(), [
      'NOTES.md',
      'src/auth/token.ts',
    ]);

    // A new file says so above its first line and is highlighted whole.
    const notes = vscode.Uri.file(path.join(workspace(), 'NOTES.md'));
    await vscode.window.showTextDocument(notes, { viewColumn: vscode.ViewColumn.One });
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      notes,
    );
    assert.deepStrictEqual(
      lenses.map((l) => l.command?.title),
      ['New file · 1 line · uncommitted', '$(review-desk-logo) Explain', 'Ask', 'Comment'],
    );
    await until('new file highlighted', () => api.handles.highlighted.get(notes.toString()) === 1);

    fs.rmSync(path.join(workspace(), 'NOTES.md'));
    run('checkout', '--', 'src/auth/token.ts');
    await until('back to the committed changes', () => !files().includes('NOTES.md'));
    await until('token.ts unchanged again', () => !files().includes('src/auth/token.ts'));
  });

  it('leaves the diff alone when only files git ignores change', async () => {
    const exclude = path.join(run('rev-parse', '--absolute-git-dir'), 'info', 'exclude');
    const kept = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : undefined;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, '\nit-ignored/\n');
    const { controller } = api;
    let refreshed = 0;
    const refresh = controller.refreshTarget;
    controller.refreshTarget = function (this: typeof controller) {
      refreshed++;
      return refresh.call(this);
    };
    const dir = path.join(workspace(), 'it-ignored');
    const token = path.join(workspace(), 'src/auth/token.ts');
    try {
      fs.mkdirSync(dir);
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `out${i}.js`), String(i));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.strictEqual(refreshed, 0, 'build output and the like change nothing');
      fs.appendFileSync(token, '// uncommitted\n');
      await until('a tracked file refreshes the diff', () => refreshed > 0);
    } finally {
      delete (controller as { refreshTarget?: unknown }).refreshTarget;
      run('checkout', '--', 'src/auth/token.ts');
      fs.rmSync(dir, { recursive: true, force: true });
      if (kept === undefined) fs.rmSync(exclude);
      else fs.writeFileSync(exclude, kept);
    }
  });

  it('fades a change with nothing to read, and says why above it', async () => {
    const files = () => api.controller.target?.files.map(filePath) ?? [];
    const token = vscode.Uri.file(path.join(workspace(), 'src/auth/token.ts'));
    const text = fs.readFileSync(token.fsPath, 'utf8');
    // Only indentation changes on the first line.
    fs.writeFileSync(token.fsPath, text.replace(/^(\s*)/, '$1    '));
    try {
      await until('token.ts changed', () => files().includes('src/auth/token.ts'));
      await vscode.workspace.openTextDocument(token);
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        token,
      );
      assert.ok(
        lenses.some((l) => l.command?.title === '$(circle-slash) whitespace only'),
        lenses.map((l) => l.command?.title).join(', '),
      );
      const rows = await api.tree.getChildren();
      const flat = async (nodes: typeof rows): Promise<typeof rows> =>
        (
          await Promise.all(
            nodes.map(async (n) => [n, ...(await flat(await api.tree.getChildren(n)))]),
          )
        ).flat();
      const row = (await flat(rows))
        .map((n) => api.tree.getTreeItem(n))
        .find((i) => i.id === 'file:src/auth/token.ts');
      assert.match(String(row?.description), /whitespace only/);
    } finally {
      run('checkout', '--', 'src/auth/token.ts');
      await until('token.ts unchanged again', () => !files().includes('src/auth/token.ts'));
    }
  });
});
