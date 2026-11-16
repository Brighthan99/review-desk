import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { FinishChoice, Finished } from '../../src/ui/finish';
import { activate, answering, freshBranch, run, topRow, workspace } from './helpers';

describe('finishing a review', () => {
  let api: ExtensionApi;
  let bare: string;
  let restore = () => {};
  const asked: { message: string; buttons: string[] }[] = [];
  let answer: (buttons: string[]) => string | undefined = () => undefined;
  const branches = () => run('branch', '--format=%(refname:short)').split('\n');
  const finish = (choice?: FinishChoice) =>
    vscode.commands.executeCommand<Finished>('reviewDesk.finishReview', choice);
  const startOn = async (name: string) => {
    await freshBranch(api, name);
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
  };

  before(async () => {
    api = await activate();
    // A remote whose default branch (its HEAD) is it-home: the branch a finished review goes
    // back to. main stays as the other suites expect it.
    run('branch', '-f', 'it-home', 'main');
    bare = path.join(path.dirname(workspace()), `${path.basename(workspace())}-home.git`);
    execFileSync('git', ['clone', '-q', '--bare', workspace(), bare]);
    run('remote', 'add', 'origin', bare);
    run('fetch', '-q', 'origin');
    run('remote', 'set-head', 'origin', 'it-home');
    restore = answering(api, {
      confirm: async () => true,
      choose: async (message, buttons) => (asked.push({ message, buttons }), answer(buttons)),
    });
  });

  after(() => {
    restore();
    run('switch', '-q', '--detach', 'fixture-refresh');
    for (const b of [
      'it-home',
      'it-finish',
      'it-finish-kept',
      'it-wt',
      'it-wt-dirty',
      'it-wt-ahead',
    ]) {
      if (branches().includes(b)) run('branch', '-q', '-D', b);
    }
    run('remote', 'remove', 'origin');
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it('goes back to the default branch, brought up to date, and deletes the merged branch', async () => {
    await startOn('it-finish');
    // Merged on the remote: its default branch now has the reviewed branch's commits.
    run('push', '-q', bare, '+it-finish:it-home');
    asked.length = 0;
    answer = (buttons) => buttons.find((b) => b.startsWith('Switch and Delete'));
    const done = await finish();
    assert.deepStrictEqual(asked[0].buttons, ['Switch and Delete it-finish', 'Switch to it-home']);
    assert.match(
      asked[0].message,
      /^Finish the review of it-finish\? This window switches to it-home, up to date with origin\/it-home/,
    );
    assert.deepStrictEqual(done, {
      done: true,
      home: 'it-home',
      deleted: 'it-finish',
      behind: false,
    });
    assert.strictEqual(run('branch', '--show-current'), 'it-home');
    assert.strictEqual(
      run('rev-parse', 'it-home'),
      run('rev-parse', 'origin/it-home'),
      'up to date',
    );
    assert.ok(!branches().includes('it-finish'), 'deleted');
    assert.strictEqual(api.controller.target, undefined, 'the review closed');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.strictEqual(api.controller.target, undefined, 'and stays closed (HEAD not followed)');
  });

  it('keeps a branch with commits the default branch lacks', async () => {
    await startOn('it-finish-kept');
    asked.length = 0;
    answer = () => undefined;
    assert.deepStrictEqual(await finish(), { done: false, why: 'cancelled' });
    assert.deepStrictEqual(asked[0].buttons, ['Switch to it-home'], 'no delete offered');
    assert.strictEqual(run('branch', '--show-current'), 'it-finish-kept', 'nothing switched');
    assert.ok(api.controller.target, 'the review still open');
    assert.deepStrictEqual(await finish('delete'), { done: false, why: 'not merged' });

    const done = await finish('switch');
    assert.deepStrictEqual(done, {
      done: true,
      home: 'it-home',
      deleted: undefined,
      behind: false,
    });
    assert.strictEqual(run('branch', '--show-current'), 'it-home');
    assert.ok(branches().includes('it-finish-kept'), 'kept');
  });

  it('starts a review again after it (the Start Review button), with no editor open', async () => {
    const target = () => api.controller.target;
    assert.strictEqual(target(), undefined, 'closed by the finish');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.ok(await vscode.commands.executeCommand('reviewDesk.start', { open: false }), 'started');
    assert.strictEqual(target()?.head.ref, 'it-home');
  });

  // A worktree of the repository next to the test folder, with `branch` checked out.
  const addWorktree = (branch: string) => {
    const dir = path.join(path.dirname(workspace()), `${path.basename(workspace())}-${branch}`);
    run('worktree', 'add', '-q', dir, branch);
    return dir;
  };
  const dropWorktree = (dir: string) => {
    if (fs.existsSync(dir)) run('worktree', 'remove', '--force', dir);
    run('worktree', 'prune');
  };

  it('removes the worktree of a review in one, with its merged branch, and closes the review', async () => {
    run('fetch', '-q', 'origin');
    // Merged on the remote only: this folder's it-home, checked out here, is not moved forward
    // to it, so git branch -d (which looks at HEAD) would refuse to delete the branch.
    assert.strictEqual(run('branch', '--show-current'), 'it-home');
    const merged = run(
      ...['commit-tree', 'origin/it-home^{tree}', '-p', 'origin/it-home'],
      ...['-m', 'merged on the remote'],
    );
    run('branch', '-f', 'it-wt', merged);
    run('push', '-q', 'origin', 'it-wt:it-home');
    const dir = addWorktree('it-wt');
    // Ignored files in it: the one no install makes again is named in the question.
    const exclude = path.resolve(workspace(), run('rev-parse', '--git-path', 'info/exclude'));
    const excluded = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, `${excluded}\nnode_modules/\nlocal.env\n`);
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '');
    fs.writeFileSync(path.join(dir, 'local.env'), 'TOKEN=1\n');
    try {
      assert.ok(
        await vscode.commands.executeCommand('reviewDesk.start', {
          cwd: dir,
          base: 'main',
          open: false,
        }),
      );
      // The review's branch row shows the folder is a worktree, and of which repository.
      const where = api.tree.getTreeItem((await topRow(api, 'where'))!);
      assert.strictEqual((where.iconPath as vscode.ThemeIcon).id, 'worktree');
      assert.match(
        String(where.tooltip),
        new RegExp(`A git worktree of ${path.basename(workspace())}\\.`),
      );
      // A file of it open: its tab closes before the folder goes.
      const file = path.join(dir, run('ls-files').split('\n')[0]);
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      asked.length = 0;
      answer = (buttons) => buttons[0];
      const done = await finish();
      assert.deepStrictEqual(asked[0].buttons, [
        'Remove Worktree and Delete it-wt',
        'Remove Worktree',
        'Close Review Only',
      ]);
      assert.match(
        asked[0].message,
        /^Finish the review of it-wt\? The worktree \S+-it-wt is removed/,
      );
      assert.match(
        asked[0].message,
        /Ignored files no build or install makes again go too: local\.env\. Copy them/,
      );
      assert.ok(done.done && 'worktree' in done, 'finished in the worktree');
      assert.strictEqual(
        fs.realpathSync(path.dirname(done.worktree)),
        fs.realpathSync(path.dirname(dir)),
      );
      assert.deepStrictEqual(
        { ...done, worktree: '' },
        {
          done: true,
          worktree: '',
          removed: true,
          deleted: 'it-wt',
        },
      );
      assert.ok(!fs.existsSync(dir), 'its folder is gone');
      assert.ok(!run('worktree', 'list').includes('it-wt'), 'git forgot it');
      assert.ok(!branches().includes('it-wt'), 'its branch deleted');
      assert.strictEqual(api.controller.target, undefined, 'the review closed');
      const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      assert.ok(
        !open.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === file),
        'its editor closed',
      );
    } finally {
      dropWorktree(dir);
      fs.writeFileSync(exclude, excluded);
    }
  });

  it('says which commits of its branch no remote has: removing the worktree keeps them, only here', async () => {
    run('fetch', '-q', 'origin');
    const ahead = run(
      ...['commit-tree', 'origin/it-home^{tree}', '-p', 'origin/it-home'],
      ...['-m', 'only here'],
    );
    run('branch', '-f', 'it-wt-ahead', ahead);
    const dir = addWorktree('it-wt-ahead');
    try {
      assert.ok(
        await vscode.commands.executeCommand('reviewDesk.start', {
          cwd: dir,
          base: 'main',
          open: false,
        }),
      );
      // The branch row says so too, and the Worktrees list beside the worktree.
      const where = api.tree.getTreeItem(
        (await api.tree.getChildren()).find((n) => api.tree.getTreeItem(n).id === 'where')!,
      );
      assert.match(String(where.description), / · ↑1 not pushed$/);
      // Its icon, a yellow arrow up: commits to push.
      const icon = (i?: vscode.TreeItem) => {
        const t = i?.iconPath as vscode.ThemeIcon;
        return [t.id, t.color?.id];
      };
      assert.deepStrictEqual(icon(where), ['arrow-up', 'charts.yellow']);
      assert.match(String(where.tooltip), /Not pushed: 1 commit on no remote yet\./);
      const listed = (await api.worktrees.getChildren())
        .map((n) => api.worktrees.getTreeItem(n))
        .find((i) => String(i.description).startsWith('it-wt-ahead'));
      assert.match(String(listed?.description), /^it-wt-ahead · ↑1 not pushed/);
      assert.deepStrictEqual(icon(listed), ['arrow-up', 'charts.yellow']);
      assert.match(String(listed?.tooltip), /A git worktree of /);
      asked.length = 0;
      answer = () => undefined;
      assert.deepStrictEqual(await finish(), { done: false, why: 'cancelled' });
      assert.deepStrictEqual(asked[0].buttons, ['Remove Worktree', 'Close Review Only']);
      assert.match(
        asked[0].message,
        /it-wt-ahead has 1 commit not pushed to any remote: only this repository has it\./,
      );
    } finally {
      api.controller.close();
      dropWorktree(dir);
    }
  });

  it('keeps a worktree with uncommitted changes, offering only to close the review', async () => {
    run('branch', '-f', 'it-wt-dirty', 'main');
    const dir = addWorktree('it-wt-dirty');
    fs.writeFileSync(path.join(dir, 'DRAFT.md'), 'not committed\n');
    try {
      assert.ok(
        await vscode.commands.executeCommand('reviewDesk.start', {
          cwd: dir,
          base: 'main',
          open: false,
        }),
      );
      // Asked to remove it without a question: refused, the review still open.
      const refused = await finish('remove');
      assert.ok(!refused.done && /uncommitted change/.test(refused.why), JSON.stringify(refused));
      assert.ok(api.controller.target, 'the review still open');

      asked.length = 0;
      answer = (buttons) => buttons[0];
      const done = await finish();
      assert.deepStrictEqual(asked[0].buttons, ['Close Review Only'], 'no removal offered');
      assert.match(
        asked[0].message,
        /cannot be removed: it has 1 uncommitted change or new file \(DRAFT\.md\)/,
      );
      assert.ok(done.done && 'worktree' in done && !done.removed, 'only the review closed');
      assert.ok(fs.existsSync(path.join(dir, 'DRAFT.md')), 'the worktree kept, with its draft');
      assert.strictEqual(api.controller.target, undefined, 'the review closed');
    } finally {
      dropWorktree(dir);
    }
  });
});
