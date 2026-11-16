import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { Repo } from '../../src/review/repos';
import { activate, answering, freshBranch, run, workspace } from './helpers';

describe('the Review list before a review starts', () => {
  let api: ExtensionApi;
  const label = (i: vscode.TreeItem) =>
    typeof i.label === 'string' ? i.label : (i.label as vscode.TreeItemLabel).label;
  const rows = async () => (await api.tree.getChildren()).map((n) => api.tree.getTreeItem(n));
  const eventually = async (what: string, check: () => Promise<boolean>) => {
    const end = Date.now() + 10000;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const root = () => fs.realpathSync(workspace());

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-idle');
    await vscode.commands.executeCommand('reviewDesk.closeReview');
  });

  after(() => {
    run('switch', '-q', '--detach', 'fixture-refresh');
    for (const b of ['it-idle', 'it-idle-2']) run('branch', '-q', '-D', b);
  });

  it("shows the folder's branch, kept current, and ways to start a review there", async () => {
    await eventually('the branch shown', async () => label((await rows())[0]) === 'it-idle');
    const [repo, ...actions] = await rows();
    assert.strictEqual(repo.description, path.basename(root()), 'its folder beside it');
    assert.strictEqual((repo.iconPath as vscode.ThemeIcon).id, 'git-branch');
    assert.strictEqual(repo.command, undefined, 'nothing to pick in a one-folder window');
    assert.deepStrictEqual(actions.map(label), [
      'Start Review',
      'Start Review Against Branch…',
      'Open GitHub Pull Request…',
    ]);

    // Switched in a terminal: the list follows without a refresh.
    run('switch', '-q', '-c', 'it-idle-2');
    await eventually('the switch shown', async () => label((await rows())[0]) === 'it-idle-2');

    // Its Start Review starts in this folder; then the review's rows, its branch first.
    const start = actions[0].command!;
    assert.deepStrictEqual(start.arguments, [{ cwd: root() }]);
    try {
      assert.ok(
        await vscode.commands.executeCommand(start.command, {
          ...start.arguments![0],
          open: false,
        }),
      );
      assert.strictEqual(api.controller.target?.head.ref, 'it-idle-2');
      const first = (await rows())[0];
      assert.strictEqual(first.id, 'where');
      assert.strictEqual(first.command, undefined, 'no other folder to review');
    } finally {
      await vscode.commands.executeCommand('reviewDesk.closeReview');
    }
  });

  it('starts in a folder picked (the command palette, a row of a multi-root window)', async () => {
    const asked: Repo[][] = [];
    const restore = answering(api, {
      pickFolder: async (repos) => (asked.push(repos), repos[0]),
    });
    try {
      assert.ok(await vscode.commands.executeCommand('reviewDesk.startInFolder'));
      assert.deepStrictEqual(
        asked[0].map((r) => [r.root, r.branch]),
        [[root(), 'it-idle-2']],
      );
      assert.strictEqual(api.controller.target?.head.ref, 'it-idle-2');
      // The repository reviewed already: nothing new. One not open here: refused.
      assert.ok(await vscode.commands.executeCommand('reviewDesk.startInFolder', root()));
      assert.strictEqual(
        await vscode.commands.executeCommand('reviewDesk.chooseFolder', '/no/such/folder'),
        false,
      );
    } finally {
      restore();
      await vscode.commands.executeCommand('reviewDesk.closeReview');
    }
  });

  it('opens a problem report: where it runs, the folders, the review, the log', async () => {
    assert.ok(await vscode.commands.executeCommand('reviewDesk.start', { open: false }));
    try {
      await vscode.commands.executeCommand('reviewDesk.reportProblem');
      const doc = vscode.window.activeTextEditor!.document;
      assert.strictEqual(doc.isUntitled, true, 'nothing saved or sent');
      const text = doc.getText();
      assert.match(text, /^# Review Desk problem report/);
      assert.match(text, /## Where it runs\n\n- Review Desk \d+\.\d+\.\d+\n/);
      assert.match(text, /\n- git .+ \(git version /);
      assert.ok(
        text.includes(`- ${path.basename(root())}: it-idle-2 (`) && text.includes('— reviewing'),
        text,
      );
      assert.match(text, /## Review\n\n- .+: it-idle-2 \([0-9a-f]{7}\) against /);
      // The log holds this window's run: the review just started is in it.
      assert.match(text, /## Log \(the last 300 lines\)\n\n```\n[\s\S]*starting a review/);
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('reviewDesk.closeReview');
    }
  });
});
