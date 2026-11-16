import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { activate, answering, freshBranch, run, until, workspace } from './helpers';

describe('saved reviews', () => {
  let api: ExtensionApi;
  let restore = () => {};
  const rows = async () => (await api.saved.getChildren()).map((n) => api.saved.getTreeItem(n));
  const row = async (branch: string) => (await rows()).find((i) => String(i.label) === branch);
  const hasNote = () => api.controller.resolved.some((a) => a.id === 's1');

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-saved-a');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
    api.controller.mutate((r) => {
      r.annotations.push({
        id: 's1',
        file: 'src/auth/session.ts',
        side: 'new',
        startLine: 8,
        endLine: 13,
        anchorText: 'if (isExpired(token)) {',
        kind: 'how',
        title: 'saved note',
        body: 'kept with the branch',
      });
    });
    await until('note', hasNote);
    await freshBranch(api, 'it-saved-b');
    restore = answering(api, { confirm: async () => true });
  });

  after(async () => {
    restore();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('lists a saved review per branch and marks the open one', async () => {
    const a = await row('it-saved-a');
    const b = await row('it-saved-b');
    assert.match(String(b?.description), /^open · base: main · 0 notes · /);
    assert.match(String(a?.description), /^base: main · 1 note · /);
    assert.deepStrictEqual(a!.command!.arguments, [workspace(), 'it-saved-a']);
  });

  it('reopens a review on another branch, switching to it', async () => {
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.openReview', workspace(), 'it-saved-a'),
    );
    assert.strictEqual(run('branch', '--show-current'), 'it-saved-a');
    await until('review of it-saved-a', () => api.controller.target?.head.ref === 'it-saved-a');
    assert.strictEqual(api.controller.target!.base.ref, 'main');
    await until('its note', hasNote);
  });

  it('carries the notes over when the branch has new commits since', async () => {
    await vscode.commands.executeCommand('reviewDesk.closeReview');
    run('commit', '-q', '--allow-empty', '-m', 'later work');
    const head = run('rev-parse', 'HEAD');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.openReview', workspace(), 'it-saved-a'),
    );
    await until('review at the new head', () => api.controller.target?.head.sha === head);
    await until('note carried', hasNote);
  });

  it('deletes a saved review after asking', async () => {
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.deleteReview', workspace(), 'it-saved-b'),
    );
    assert.strictEqual(await row('it-saved-b'), undefined);
    assert.ok(await row('it-saved-a'));
  });

  it('continues the branch review after HEAD moved while no review followed it', async () => {
    await freshBranch(api, 'it-saved-moved');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
    api.controller.mutate((r) => {
      r.annotations.push({
        id: 'm1',
        file: 'src/auth/session.ts',
        side: 'new',
        startLine: 8,
        endLine: 13,
        anchorText: 'if (isExpired(token)) {',
        kind: 'how',
        title: 'note before the commit',
        body: 'carried',
      });
    });
    await until('note', () => api.controller.resolved.some((a) => a.id === 'm1'));
    // A commit nobody follows, as with the window closed.
    api.controller.close();
    run('commit', '-q', '--allow-empty', '-m', 'moved while closed');
    const moved = run('rev-parse', 'HEAD');

    await api.controller.restore();
    assert.strictEqual(api.controller.target?.head.sha, moved);
    assert.ok(
      api.controller.review?.annotations.some((a) => a.id === 'm1'),
      'notes carried',
    );
  });

  it('reloads nothing for an unchanged diff, and refreshes only what the saved list shows', async () => {
    let changes = 0;
    let savedRefreshes = 0;
    const subs = [
      api.controller.onDidChange(() => changes++),
      api.saved.onDidChangeTreeData(() => savedRefreshes++),
    ];
    try {
      await api.controller.refreshTarget();
      assert.strictEqual(changes, 0, 'no reload when the diff is the same');

      api.controller.mutate((r) => {
        r.annotations[0].understood = true;
      });
      await until('reloaded', () => changes > 0);
      await new Promise((r) => setTimeout(r, 1500));
      assert.strictEqual(changes, 1, 'its own save is not reloaded a second time');
      assert.strictEqual(savedRefreshes, 0, 'an edited note changes nothing the saved list shows');

      api.controller.mutate((r) => {
        r.annotations.push({ ...r.annotations[0], id: 'm2', understood: false });
      });
      await until('saved list refreshed for the new count', () => savedRefreshes > 0);
    } finally {
      for (const s of subs) s.dispose();
    }
  });

  it('keeps the review of a renamed branch, so the next commit carries its notes', async () => {
    await freshBranch(api, 'it-saved-old-name');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
    api.controller.mutate((r) => {
      r.annotations.push({
        id: 'n1',
        file: 'src/auth/session.ts',
        side: 'new',
        startLine: 8,
        endLine: 13,
        anchorText: 'if (isExpired(token)) {',
        kind: 'how',
        title: 'note before the rename',
        body: '',
      });
    });
    await until('note', () => api.controller.resolved.some((a) => a.id === 'n1'));

    run('branch', '-m', 'it-saved-new-name');
    await until(
      'review on the new name',
      () => api.controller.review?.head.ref === 'it-saved-new-name',
    );
    run('commit', '-q', '--allow-empty', '-m', 'after the rename');
    const head = run('rev-parse', 'HEAD');
    await until('followed the commit', () => api.controller.target?.head.sha === head);
    assert.ok(
      api.controller.review?.annotations.some((a) => a.id === 'n1'),
      'notes carried',
    );
  });
});
