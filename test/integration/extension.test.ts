import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'brighthan99.review-desk';

describe('extension', () => {
  it('activates in a git workspace', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'extension is installed');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  it('registers the start command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('reviewDesk.start'));
  });
});
