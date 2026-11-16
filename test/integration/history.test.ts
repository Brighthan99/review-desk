import * as assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { activate, freshBranch, run, topRow, until, workspace } from './helpers';

describe('the commits between the sides', () => {
  let api: ExtensionApi;
  const label = (i: vscode.TreeItem) =>
    typeof i.label === 'string' ? i.label : (i.label as vscode.TreeItemLabel).label;
  const rows = async () => {
    const base = await topRow(api, 'base');
    return (await api.tree.getChildren(base)).map((n) => api.tree.getTreeItem(n));
  };
  const commits = async () =>
    (await rows()).filter((r) => ['historyHead', 'historyCommit'].includes(String(r.contextValue)))
      .length;
  const more = async () => (await rows()).find((r) => r.id === 'history:more');

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-history');
    // Not run(): 70 git calls in a row would block the extension host.
    const git = promisify(execFile);
    for (let i = 1; i <= 70; i++) {
      await git('git', ['commit', '-q', '--allow-empty', '-m', `step ${i}`], { cwd: workspace() });
    }
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
    const head = run('rev-parse', 'HEAD');
    await until('on the last commit', () => api.controller.target?.head.sha === head);
  });

  it('shows the first 15, and 50 more for each click on "… more commits"', async () => {
    const total = Number(run('rev-list', '--count', 'main..HEAD'));
    assert.ok(total > 65, `${total} commits`);
    assert.strictEqual(await commits(), 15);
    const first = (await more())!;
    assert.strictEqual(label(first), `… ${total - 15} more commits`);
    assert.strictEqual(first.description, 'show 50 more');
    assert.strictEqual(first.command?.command, 'reviewDesk.tree.moreCommits');

    await vscode.commands.executeCommand('reviewDesk.tree.moreCommits');
    assert.strictEqual(await commits(), 65);
    const second = (await more())!;
    assert.strictEqual(label(second), `… ${total - 65} more commits`);
    assert.strictEqual(second.description, 'show');

    await vscode.commands.executeCommand('reviewDesk.tree.moreCommits');
    assert.strictEqual(await commits(), total);
    assert.strictEqual(await more(), undefined, 'all shown');

    // A new commit keeps them all shown; another left side starts from 15 again.
    run('commit', '-q', '--allow-empty', '-m', 'one more');
    const head = run('rev-parse', 'HEAD');
    await until('followed', () => api.controller.target?.head.sha === head);
    assert.strictEqual(await commits(), total + 1);
    const base = run('rev-parse', 'HEAD~40');
    await vscode.commands.executeCommand('reviewDesk.compareFrom', { row: { sha: base } });
    await until('base moved', () => api.controller.target?.base.sha === base);
    assert.strictEqual(await commits(), 15);
  });
});
