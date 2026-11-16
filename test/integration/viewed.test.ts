import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { activate, freshBranch, run, topRow, until, workspace } from './helpers';

describe('files marked viewed', () => {
  let api: ExtensionApi;
  const file = 'src/auth/session.ts';
  const abs = () => path.join(workspace(), file);
  const state = () => api.controller.viewed.get(file);

  /** Every row of the list, nested ones included. */
  const rows = async () => {
    const all: vscode.TreeItem[] = [];
    const walk = async (nodes: unknown[]) => {
      for (const n of nodes) {
        all.push(api.tree.getTreeItem(n as never));
        await walk(await api.tree.getChildren(n as never));
      }
    };
    await walk(await api.tree.getChildren());
    return all;
  };
  const row = async () => (await rows()).find((i) => i.id === `file:${file}`);
  const tick = (on: boolean) =>
    api.tree.checked([
      [
        { kind: 'file', path: file },
        on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      ],
    ]);
  const checkbox = (item: vscode.TreeItem | undefined) =>
    typeof item?.checkboxState === 'object' ? item.checkboxState.state : item?.checkboxState;

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-viewed');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
  });

  after(async () => {
    api.tree.setHideViewed(false);
    run('checkout', '--', '.');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('ticks a file viewed, hides it on request, and counts it', async () => {
    assert.strictEqual(checkbox(await row()), vscode.TreeItemCheckboxState.Unchecked);
    await tick(true);
    await until('viewed', () => state() === 'viewed');
    assert.strictEqual(checkbox(await row()), vscode.TreeItemCheckboxState.Checked);
    assert.ok(api.controller.review?.viewed?.[file]?.blob, 'the version seen is kept');
    const total = api.controller.target!.files.length;
    assert.strictEqual(api.tree.view?.description, `1 of ${total} viewed`);
    // The branch on a row of its own, where it has room.
    const where = api.tree.getTreeItem((await topRow(api, 'where'))!);
    assert.strictEqual(where.label, 'it-viewed');
    assert.strictEqual(where.description, path.basename(workspace()));

    api.tree.setHideViewed(true);
    assert.strictEqual(await row(), undefined, 'hidden while viewed');
    api.tree.setHideViewed(false);
    assert.ok(await row());

    // The same version at HEAD: still viewed when the right side is HEAD only.
    assert.ok(await vscode.commands.executeCommand('reviewDesk.changeRight', { kind: 'head' }));
    await until('HEAD only', () => api.controller.target?.workTree === false);
    assert.strictEqual(state(), 'viewed');
    assert.ok(await vscode.commands.executeCommand('reviewDesk.changeRight', { kind: 'workTree' }));
    await until('working tree', () => api.controller.target?.workTree === true);
  });

  it('unticks itself once the file changes, and diffs what changed since', async () => {
    fs.appendFileSync(abs(), '// changed after viewing\n');
    await until('changed since viewed', () => state() === 'changed');
    const item = await row();
    assert.strictEqual(checkbox(item), vscode.TreeItemCheckboxState.Unchecked);
    assert.match(String(item?.description), /changed since viewed/);
    assert.strictEqual(item?.contextValue, 'changedFileSinceViewed');

    api.tree.setHideViewed(true);
    assert.ok(await row(), 'a file changed since viewed shows again');
    api.tree.setHideViewed(false);

    assert.ok(await vscode.commands.executeCommand('reviewDesk.diffSinceViewed', file));
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, 'a diff opened');
    assert.strictEqual(input.original.scheme, 'review-desk-blob');
    const before = await vscode.workspace.openTextDocument(input.original);
    const now = await vscode.workspace.openTextDocument(input.modified);
    assert.ok(!before.getText().includes('// changed after viewing'), 'left: the version viewed');
    assert.ok(now.getText().includes('// changed after viewing'), 'right: the file now');
  });

  it('keeps the marks on the next commit, and marks the file in the editor', async () => {
    run('commit', '-q', '-am', 'change after viewing');
    const head = run('rev-parse', 'HEAD');
    await until('followed the commit', () => api.controller.target?.head.sha === head);
    await until('mark carried, still changed', () => state() === 'changed');

    await vscode.window.showTextDocument(vscode.Uri.file(abs()));
    assert.ok(await vscode.commands.executeCommand('reviewDesk.markViewed'));
    await until('viewed again', () => state() === 'viewed');
    assert.ok(await vscode.commands.executeCommand('reviewDesk.markNotViewed'));
    await until('not viewed', () => state() === undefined);
    assert.strictEqual(api.controller.review?.viewed, undefined);

    // The editor title's buttons pass the editor's Uri.
    const uri = vscode.Uri.file(abs());
    assert.ok(await vscode.commands.executeCommand('reviewDesk.markViewed', uri));
    await until('viewed from the title button', () => state() === 'viewed');
    assert.ok(await vscode.commands.executeCommand('reviewDesk.markNotViewed', uri));
    await until('not viewed from the title button', () => state() === undefined);
  });

  it('shows the branch it is on, and follows another branch checked out elsewhere', async () => {
    run('switch', '-q', '-c', 'it-viewed-other');
    try {
      await until('followed', () => api.controller.target?.head.ref === 'it-viewed-other');
      assert.strictEqual(api.controller.branchLabel(), 'it-viewed-other');
      assert.strictEqual(
        api.tree.getTreeItem((await topRow(api, 'where'))!).label,
        'it-viewed-other',
      );
    } finally {
      run('switch', '-q', 'it-viewed');
      await until('back', () => api.controller.target?.head.ref === 'it-viewed');
    }
  });
});
