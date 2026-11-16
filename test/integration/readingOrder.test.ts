import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { filePath } from '../../src/review/diffParser';
import { activate, fakeCalls, freshBranch, until, useFakeClaude } from './helpers';

describe('reading order and flow with the summary', () => {
  let api: ExtensionApi;
  const config = () => vscode.workspace.getConfiguration('reviewDesk');

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-order');
    await useFakeClaude(true);
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
  });

  after(async () => {
    delete process.env.FAKE_CLAUDE_ANSWER;
    api.tree.setMode('folder');
    for (const key of ['summaryReadingOrder', 'summaryDiagram'])
      await config().update(key, undefined, vscode.ConfigurationTarget.Global);
    await useFakeClaude(false);
  });

  it('asks for them, and lists the files step by step in that order', async () => {
    const files = api.controller.target!.files.map(filePath);
    assert.ok(files.length >= 2, 'the fixture changes several files');
    const order = [
      { title: 'First', why: 'What the rest builds on.', files: [files[1]] },
      { title: 'Then', files: [`${files[0]}:3-5`, 'src/nowhere.ts'] },
    ];
    process.env.FAKE_CLAUDE_ANSWER = `The change.\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n\n\`\`\`review-desk-order\n${JSON.stringify(order)}\n\`\`\``;
    assert.ok(await vscode.commands.executeCommand('reviewDesk.summarize'));
    await until('summary saved', () => !!api.controller.review?.overview?.includes('"First"'));
    const prompt = fakeCalls().at(-1)!.prompt;
    assert.ok(prompt.includes('a ```mermaid block'), 'asks for the flow');
    assert.ok(prompt.includes('a ```review-desk-order block'), 'asks for the order');

    api.tree.setMode('reading');
    const rows = await api.tree.getChildren();
    const items = rows.map((n) => api.tree.getTreeItem(n));
    const steps = items.filter((i) => i.id?.startsWith('step:'));
    assert.deepStrictEqual(
      steps.map((i) => i.label),
      ['1. First', '2. Then', ...(files.length > 2 ? ['3. Other changed files'] : [])],
    );
    assert.match(String(steps[0].description), /What the rest builds on/);
    const then = await api.tree.getChildren(rows[items.indexOf(steps[1])]);
    const kids = then.map((n) => api.tree.getTreeItem(n));
    assert.strictEqual(kids.length, 1, 'a file not in the change is left out');
    assert.match(String(kids[0].description), /:3–5/);
    assert.deepStrictEqual(kids[0].command?.arguments, [files[0], 3]);
  });

  it('does not ask for them when they are turned off', async () => {
    await config().update('summaryReadingOrder', false, vscode.ConfigurationTarget.Global);
    await config().update('summaryDiagram', false, vscode.ConfigurationTarget.Global);
    const calls = fakeCalls().length;
    assert.ok(api.panel.explain.summarize());
    await until(
      'written again',
      () => fakeCalls().length > calls && !api.panel.explain.isSummarizing,
    );
    const prompt = fakeCalls().at(-1)!.prompt;
    assert.ok(!prompt.includes('```mermaid'));
    assert.ok(!prompt.includes('review-desk-order'));
  });
});
