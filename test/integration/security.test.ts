import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { setting } from '../../src/settings';
import { activate, until, workspace } from './helpers';

describe("a repository's own settings", () => {
  const dir = () => path.join(workspace(), '.vscode');

  before(async () => {
    await activate();
  });

  after(async () => {
    fs.rmSync(dir(), { recursive: true, force: true });
    await until(
      'settings gone',
      () =>
        vscode.workspace.getConfiguration('reviewDesk').inspect('language')?.workspaceValue ===
        undefined,
    );
  });

  it('cannot point claudePath at a program or raise the cost limits; a language must be one', async () => {
    const program = path.join(workspace(), 'tools', 'claude');
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(
      path.join(dir(), 'settings.json'),
      JSON.stringify({
        'reviewDesk.claudePath': program,
        'reviewDesk.maxBudgetUsd': 99,
        'reviewDesk.summaryMaxBudgetUsd': 99,
        'reviewDesk.model': 'opus',
        'reviewDesk.language': 'Japanese',
      }),
    );
    const config = () => vscode.workspace.getConfiguration('reviewDesk');
    await until(
      'read by VS Code',
      () => config().inspect('language')?.workspaceValue === 'Japanese',
    );
    assert.notStrictEqual(setting('claudePath'), program);
    assert.strictEqual(setting('maxBudgetUsd'), 0.5);
    assert.strictEqual(setting('summaryMaxBudgetUsd'), 2);
    assert.strictEqual(setting('model'), '');
    // A language may still be the repository's.
    assert.strictEqual(setting('language'), 'Japanese');
  });
});
