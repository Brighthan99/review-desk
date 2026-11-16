import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { MenuItem } from '../../src/ui/menu';
import { activate, answering, freshBranch } from './helpers';

describe("the Review Desk menu (the list's ☰ button, the status bar item)", () => {
  let api: ExtensionApi;
  const plain = (label: string) => label.replace(/^\$\([\w-]+\) /, '');
  /** Opens the menu, picking the item whose label is `pick` (none: just looks). */
  const menu = async (pick?: string) => {
    let shown: MenuItem[] = [];
    const restore = answering(api, {
      pickMenu: async (items) => (
        (shown = items),
        items.find((i) => pick && plain(i.label) === pick)
      ),
    });
    try {
      await vscode.commands.executeCommand('reviewDesk.showActions');
    } finally {
      restore();
    }
    const headings = shown.filter((i) => i.kind === vscode.QuickPickItemKind.Separator);
    const rows = shown.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator);
    return {
      headings: headings.map((i) => i.label),
      labels: rows.map((i) => plain(i.label)),
      row: (label: string) => rows.find((i) => plain(i.label) === label),
    };
  };

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-menu');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
    );
  });

  after(async () => {
    api.tree.setMode('folder');
    api.tree.setHideViewed(false);
  });

  it('has what the list title had, and the rest, in sections', async () => {
    const m = await menu();
    assert.deepStrictEqual(m.headings, ['Show in the list', 'Review', 'GitHub', 'Claude', 'Help']);
    for (const label of [
      'Folders',
      'Notes in Order',
      'Show All Files',
      'Hide Viewed Files',
      'Expand All',
      'Collapse All',
      'Open Notes Panel',
      'Finish Review…',
      'Fetch',
      'Open GitHub Pull Request',
      'Change Answer Language…',
      'Report a Problem…',
    ]) {
      assert.ok(m.labels.includes(label), `${label} in ${m.labels.join(', ')}`);
    }
    assert.strictEqual(m.row('Folders')?.description, '✓ now');
  });

  it('switches how the list shows the review, and says which it shows', async () => {
    await menu('Notes in Order');
    assert.strictEqual(api.tree.mode, 'order');
    const m = await menu();
    assert.strictEqual(m.row('Notes in Order')?.description, '✓ now');
    assert.ok(!m.labels.includes('Hide Viewed Files'), 'not for notes');

    await menu('Folders');
    await menu('Hide Viewed Files');
    assert.strictEqual(api.tree.hideViewed, true);
    assert.ok((await menu()).labels.includes('Show Viewed Files'));
  });

  it('offers ways to start one when no review is open', async () => {
    await vscode.commands.executeCommand('reviewDesk.closeReview');
    try {
      const m = await menu();
      assert.deepStrictEqual(m.headings, ['Start', 'GitHub', 'Claude', 'Help']);
      assert.deepStrictEqual(m.labels.slice(0, 2), [
        'Start Review',
        'Start Review Against Branch…',
      ]);
      assert.ok(!m.labels.includes('Finish Review…'));
    } finally {
      assert.ok(
        await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false }),
      );
    }
  });
});
