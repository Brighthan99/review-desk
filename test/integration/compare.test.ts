import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { WorktreeRow } from '../../src/ui/worktreesTree';
import { activate, answering, freshBranch, run, topRow, until } from './helpers';

describe('picking the sides of the comparison', () => {
  let api: ExtensionApi;
  let restore = () => {};
  // The right end of the comparison: the top row under the base row.
  const rightRow = async () => {
    const base = await topRow(api, 'base');
    const [right] = await api.tree.getChildren(base);
    return api.tree.getTreeItem(right);
  };
  const removeWorktree = (dir: string) => run('worktree', 'remove', '--force', dir);
  const uncommitted = (): string[] => api.controller.target?.uncommitted ?? [];

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-compare');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
    restore = answering(api, { confirm: async () => true });
  });

  after(() => restore());

  it('reviews HEAD only on the right, and keeps that as HEAD moves', async () => {
    fs.appendFileSync(path.join(run('rev-parse', '--show-toplevel'), 'src/index.ts'), '// wip\n');
    try {
      assert.ok(await vscode.commands.executeCommand('reviewDesk.changeRight', { kind: 'head' }));
      assert.strictEqual(api.controller.target?.workTree, false);
      assert.deepStrictEqual(uncommitted(), [], 'uncommitted edits left out');
      const right = await rightRow();
      assert.match(String(right.description), /HEAD only · change…$/);
      assert.strictEqual(right.command?.command, 'reviewDesk.changeRight');

      run('commit', '-q', '--allow-empty', '-m', 'move HEAD');
      const head = run('rev-parse', 'HEAD');
      await until('followed', () => api.controller.target?.head.sha === head);
      assert.strictEqual(api.controller.target?.workTree, false, 'still HEAD only');
      assert.strictEqual(api.controller.review?.workTree, false, 'kept in the review');

      assert.ok(
        await vscode.commands.executeCommand('reviewDesk.changeRight', { kind: 'workTree' }),
      );
      assert.ok(uncommitted().includes('src/index.ts'));
      assert.strictEqual(api.controller.target?.base.ref, 'main', 'the left side stays');
    } finally {
      run('checkout', '--', 'src/index.ts');
    }
  });

  it('opens another branch in a worktree for a new window, with the same left side', async () => {
    let opened: string | undefined;
    api.prompts.openFolder = async (dir) => {
      opened = dir;
    };
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.changeRight', {
        kind: 'ref',
        ref: 'feat/rename',
        mode: 'worktree',
      }),
    );
    assert.ok(opened && fs.existsSync(opened));
    try {
      // Listed with the worktrees, as made by Review Desk, with its remove command to copy.
      const rows = (await api.worktrees.getChildren()).map((n) => ({
        node: n,
        row: (n as { row: WorktreeRow }).row,
        item: api.worktrees.getTreeItem(n),
      }));
      const mine = rows.find(
        (r) =>
          fs.realpathSync(r.item.tooltip!.toString().split('\n')[0]) === fs.realpathSync(opened!),
      )!;
      assert.ok(mine, 'listed');
      assert.match(String(mine.item.description), /^feat\/rename · made by Review Desk$/);
      const cmd = await vscode.commands.executeCommand<string>(
        'reviewDesk.copyWorktreeRemove',
        mine.node,
      );
      assert.strictEqual(await vscode.env.clipboard.readText(), cmd);
      assert.match(cmd, /^git -C ".+" worktree remove ".+-feat-rename"$/);
      const main = rows.find((r) => r.item.contextValue === 'worktreeMainHere');
      assert.match(
        String(main?.item.description),
        /main folder · this window · reviewed · \d+ notes?/,
      );
      // The repository's own folder, and a worktree made from it, told apart by their icons.
      const icon = (item: vscode.TreeItem) => (item.iconPath as vscode.ThemeIcon).id;
      assert.deepStrictEqual([icon(main!.item), icon(mine.item)], ['repo', 'worktree']);

      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: opened, encoding: 'utf8' }).trim();
      assert.strictEqual(git('branch', '--show-current'), 'feat/rename');
      const pending = JSON.parse(
        fs.readFileSync(
          path.join(git('rev-parse', '--absolute-git-dir'), 'review-desk-pending.json'),
          'utf8',
        ),
      );
      assert.deepStrictEqual([pending.base, pending.workTree], ['main', true]);
      assert.strictEqual(api.controller.target?.head.ref, 'it-compare', 'this window stays');

      // Its row reviews it in this window: added as a folder, with a review left for it (the
      // default base); the window's review moves there once it is in.
      const pendingNow = () =>
        JSON.parse(
          fs.readFileSync(
            path.join(git('rev-parse', '--absolute-git-dir'), 'review-desk-pending.json'),
            'utf8',
          ),
        );
      assert.strictEqual(mine.item.command?.command, 'reviewDesk.reviewWorktree');
      const added: string[] = [];
      const restoreAdd = answering(api, { addFolder: async (dir) => void added.push(dir) });
      try {
        await vscode.commands.executeCommand('reviewDesk.reviewWorktree', mine.node);
        assert.deepStrictEqual(added, [mine.row.info.path]);
        assert.deepStrictEqual(pendingNow(), {});
        // Open in New Window: the review starts in that window too.
        opened = undefined;
        await vscode.commands.executeCommand('reviewDesk.openWorktree', mine.node);
        assert.strictEqual(opened, mine.row.info.path);
        assert.deepStrictEqual(pendingNow(), {});
      } finally {
        restoreAdd();
      }
      // The folder of the review open here: nothing to add, nothing restarts.
      const started = api.controller.target;
      await vscode.commands.executeCommand('reviewDesk.reviewWorktree', main!.node);
      assert.strictEqual(api.controller.target, started);
    } finally {
      removeWorktree(opened!);
    }
  });

  it('adds another branch to this window as a worktree folder, where its review starts', async () => {
    const t = api.controller.target!;
    const here = { root: t.root, base: t.base.ref, workTree: t.workTree };
    const added: string[] = [];
    const restoreAdd = answering(api, { addFolder: async (dir) => void added.push(dir) });
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.changeRight', {
        kind: 'ref',
        ref: 'feat/rename',
        mode: 'folder',
      }),
    );
    const dir = added[0];
    try {
      assert.strictEqual(added.length, 1);
      assert.ok(fs.existsSync(dir));
      assert.strictEqual(api.controller.target?.head.ref, 'it-compare', 'not before it is added');
      // Once the folder is in the window (here, as if it were), the review left for it starts
      // there, with this window's left side; the one of the other folder closes first.
      assert.ok(await api.github.resumePending([dir]));
      const now = api.controller.target!;
      assert.strictEqual(fs.realpathSync(now.root), fs.realpathSync(dir));
      assert.deepStrictEqual(
        [now.head.ref, now.base.ref, now.workTree],
        ['feat/rename', 'main', true],
      );
      assert.strictEqual(await api.github.resumePending([dir]), false, 'started once');

      // The Worktrees list adds a worktree the same way.
      const rows = await api.worktrees.getChildren();
      const mine = rows.find((n) => {
        const p = (n as { row?: WorktreeRow }).row?.info.path;
        return !!p && fs.existsSync(p) && fs.realpathSync(p) === fs.realpathSync(dir);
      });
      assert.ok(mine, 'listed');
      await vscode.commands.executeCommand('reviewDesk.addWorktreeToWindow', mine);
      assert.deepStrictEqual(added, [dir, (mine as { row: WorktreeRow }).row.info.path]);
    } finally {
      restoreAdd();
      api.controller.close();
      removeWorktree(dir);
      assert.ok(
        await vscode.commands.executeCommand('reviewDesk.start', {
          cwd: here.root,
          base: here.base,
          workTree: here.workTree,
          open: false,
        }),
      );
    }
  });

  it('checks a commit row out as the right side, detached in a worktree', async () => {
    let opened: string | undefined;
    api.prompts.openFolder = async (dir) => {
      opened = dir;
    };
    const sha = run('rev-parse', 'HEAD~1');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.compareTo', { row: { sha } }, 'worktree'),
    );
    try {
      assert.strictEqual(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: opened, encoding: 'utf8' }).trim(),
        sha,
      );
    } finally {
      removeWorktree(opened!);
    }
  });

  it('lists worktrees added and removed by git outside Review Desk, without a refresh', async () => {
    const root = run('rev-parse', '--show-toplevel');
    const dir = path.join(path.dirname(root), `${path.basename(root)}-it-outside`);
    // Compared through the real parent folder (/var is /private/var), also once dir is gone.
    const real = path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
    const listed = async () =>
      (await api.worktrees.getChildren()).some((n) => {
        const p = (n as { row?: { info: { path: string } } }).row?.info.path;
        return !!p && path.join(fs.realpathSync(path.dirname(p)), path.basename(p)) === real;
      });
    // Shown, watching from now on: with no other worktree, still the repository's own folder.
    const before = await api.worktrees.getChildren();
    assert.deepStrictEqual(
      before.map((n) => api.worktrees.getTreeItem(n).contextValue),
      ['worktreeMainHere'],
    );
    let fired = 0;
    const sub = api.worktrees.onDidChangeTreeData(() => fired++);
    try {
      run('worktree', 'add', '-q', '--detach', dir, 'HEAD');
      await until('the new worktree noticed', () => fired > 0);
      assert.ok(await listed(), 'listed');
      fired = 0;
      removeWorktree(dir);
      await until('the removed worktree noticed', () => fired > 0);
      assert.ok(!(await listed()), 'gone');
    } finally {
      sub.dispose();
      if (fs.existsSync(dir)) removeWorktree(dir);
    }
  });

  it('redraws the Worktrees list only when what it shows changed, and survives a click meanwhile', async () => {
    // Past the refreshes the earlier tests' worktrees set off; then what the list shows now.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await api.worktrees.refresh();
    await api.worktrees.getChildren();
    let fired = 0;
    const sub = api.worktrees.onDidChangeTreeData(() => fired++);
    try {
      // Nothing changed (as on coming back to the window): read again, nothing redrawn.
      await api.worktrees.refresh();
      assert.strictEqual(fired, 0, 'not redrawn');
      // A worktree more: redrawn once, with the rows read already.
      const root = run('rev-parse', '--show-toplevel');
      const dir = path.join(path.dirname(root), `${path.basename(root)}-it-redraw`);
      run('worktree', 'add', '-q', '--detach', dir, 'HEAD');
      try {
        await api.worktrees.refresh();
        assert.ok(fired >= 1, 'redrawn');
        const rows = await api.worktrees.getChildren();
        assert.ok(rows.length >= 2, 'the new one listed');
      } finally {
        removeWorktree(dir);
      }
    } finally {
      sub.dispose();
    }
    // A row's button clicked while VS Code had forgotten the rows: no row, no failure.
    for (const cmd of ['removeWorktree', 'copyWorktreeRemove', 'openWorktree', 'reviewWorktree']) {
      assert.strictEqual(await vscode.commands.executeCommand(`reviewDesk.${cmd}`), undefined, cmd);
    }
    assert.strictEqual(await vscode.commands.executeCommand('reviewDesk.deleteReview'), false);
  });

  it('removes a worktree from the list, or says why it cannot', async () => {
    const root = run('rev-parse', '--show-toplevel');
    const dir = path.join(path.dirname(root), `${path.basename(root)}-it-remove`);
    run('worktree', 'add', '-q', '--detach', dir, 'HEAD');
    const told: string[] = [];
    let asked = 0;
    const restoreHere = answering(api, {
      warn: (m) => told.push(m),
      confirm: async () => (asked++, true),
    });
    const rows = async () =>
      (await api.worktrees.getChildren())
        .map((n) => (n as { row?: WorktreeRow }).row)
        .filter((r): r is WorktreeRow => !!r);
    const rowOf = async (p: string) =>
      (await rows()).find(
        (r) => fs.existsSync(r.info.path) && fs.realpathSync(r.info.path) === fs.realpathSync(p),
      )!;
    try {
      // The repository's own folder (this window's): never removed.
      const here = (await rows()).find((r) => r.here)!;
      assert.strictEqual(await api.worktrees.remove(here), false);
      assert.match(told.at(-1)!, /the repository's main folder/);

      fs.writeFileSync(path.join(dir, 'draft.txt'), 'x');
      assert.strictEqual(await api.worktrees.remove(await rowOf(dir)), false);
      assert.match(told.at(-1)!, /1 uncommitted change or new file \(draft\.txt\)/);
      assert.strictEqual(asked, 0, 'not asked when it cannot be removed');
      assert.ok(fs.existsSync(dir));

      // A worktree that is one of this window's folders (added to it): removed too, its
      // editors closed before its files go.
      fs.rmSync(path.join(dir, 'draft.txt'));
      const file = path.join(dir, run('ls-files').split('\n')[0]);
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      assert.ok(await api.worktrees.remove({ ...(await rowOf(dir)), here: true }));
      assert.strictEqual(asked, 1);
      assert.ok(!fs.existsSync(dir), 'folder removed');
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      assert.ok(
        !tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === file),
        'its editor closed',
      );
    } finally {
      restoreHere();
      if (fs.existsSync(dir)) removeWorktree(dir);
    }
  });

  it('sends a branch another worktree has to that window instead of switching here', async () => {
    const root = run('rev-parse', '--show-toplevel');
    const dir = path.join(path.dirname(root), `${path.basename(root)}-it-held`);
    run('worktree', 'add', '-q', '-b', 'it-held', dir, 'HEAD');
    const opened: string[] = [];
    const asked: string[] = [];
    const restoreHere = answering(api, {
      openFolder: async (d) => void opened.push(d),
      confirm: async (m) => (asked.push(m), true),
    });
    try {
      assert.ok(
        await vscode.commands.executeCommand('reviewDesk.changeRight', {
          kind: 'ref',
          ref: 'it-held',
          mode: 'here',
        }),
      );
      assert.match(asked[0], /has it-held checked out, so it cannot be checked out here too/);
      assert.deepStrictEqual(
        opened.map((d) => fs.realpathSync(d)),
        [fs.realpathSync(dir)],
      );
      assert.strictEqual(run('branch', '--show-current'), 'it-compare', 'this window stays');
      const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
      const pending = JSON.parse(
        fs.readFileSync(path.join(gitDir, 'review-desk-pending.json'), 'utf8'),
      );
      assert.deepStrictEqual([pending.base, pending.workTree], ['main', true]);
    } finally {
      restoreHere();
      removeWorktree(dir);
      run('branch', '-q', '-D', 'it-held');
    }
  });

  it('switches to another branch here, keeping the left side, the list busy meanwhile', async () => {
    const shown: string[] = [];
    const restoreHere = answering(api, {
      progress: (title, task) => (shown.push(title), task()),
    });
    try {
      assert.ok(
        await vscode.commands.executeCommand('reviewDesk.changeRight', {
          kind: 'ref',
          ref: 'feat/rename',
          mode: 'here',
        }),
      );
      assert.strictEqual(run('branch', '--show-current'), 'feat/rename');
      await until('reviewing feat/rename', () => api.controller.target?.head.ref === 'feat/rename');
      assert.strictEqual(api.controller.target?.base.ref, 'main');
      // The switch, then the review computed again on it (a HEAD check may follow).
      assert.deepStrictEqual(shown.slice(0, 2), [
        'Switching to feat/rename…',
        'Updating the review…',
      ]);
    } finally {
      restoreHere();
      run('switch', '-q', 'it-compare');
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false });
    }
  });
});
