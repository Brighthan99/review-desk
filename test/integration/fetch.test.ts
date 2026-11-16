import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { activate, answering, freshBranch, run, until, workspace } from './helpers';

describe('fetching the remotes', () => {
  let api: ExtensionApi;
  let bare: string;
  const remote = (...args: string[]) =>
    execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-fetch');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
    bare = path.join(path.dirname(workspace()), `${path.basename(workspace())}-fetch.git`);
    execFileSync('git', ['clone', '-q', '--bare', workspace(), bare]);
    run('remote', 'add', 'upstream', bare);
    run('fetch', '-q', 'upstream');
  });

  after(() => {
    run('remote', 'remove', 'upstream');
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it('fetches, says what moved and what was deleted, and refreshes the list', async () => {
    // On the remote: main gets a commit, feat/rename is deleted. Made there, not pushed: a
    // push to the remote's path moves upstream/main here too (git 2.56 and later).
    const next = remote(
      ...['-c', 'user.name=Remote', '-c', 'user.email=remote@example.com'],
      ...['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'on the remote'],
    );
    remote('update-ref', 'refs/heads/main', next);
    remote('update-ref', '-d', 'refs/heads/feat/rename');
    let fetched = 0;
    const sub = api.controller.onDidFetch(() => fetched++);
    try {
      const shown: string[] = [];
      const restore = answering(api, { progress: (title, task) => (shown.push(title), task()) });
      let changes: string[];
      try {
        changes = await vscode.commands.executeCommand<string[]>('reviewDesk.fetch');
      } finally {
        restore();
      }
      assert.strictEqual(shown[0], 'Fetching…', 'the list busy while fetching');
      assert.ok(changes.includes('upstream/main +1 commit'), changes.join(', '));
      assert.ok(changes.includes('upstream/feat/rename deleted'), changes.join(', '));
      // Told once: the FETCH_HEAD it wrote is not taken for a fetch from elsewhere too.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.strictEqual(fetched, 1, 'the list is told, once');
      assert.deepStrictEqual(
        await vscode.commands.executeCommand<string[]>('reviewDesk.fetch'),
        [],
        'nothing new the second time',
      );

      // A fetch from elsewhere (a terminal, VS Code's autofetch) is noticed too.
      fetched = 0;
      run('fetch', '-q', 'upstream');
      await until('fetch noticed', () => fetched > 0);
    } finally {
      sub.dispose();
    }
  });
});
