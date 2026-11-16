import * as vscode from 'vscode';
import type { ReviewEvent } from './convert';

/**
 * Reviews shown in an editor before posting, to read and edit, with buttons at the top of
 * each (CodeLens) to post it as comments, approving or requesting changes, or not at all.
 */
export class ReviewPreviews implements vscode.Disposable {
  /** Previews open now, by document URI, waiting for how to post them. */
  private readonly waiting = new Map<string, (event: ReviewEvent | undefined) => void>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();

  /** The buttons at the top of a preview: how to post it, or not at all. */
  readonly lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: this.lensesChanged.event,
    provideCodeLenses: (doc) => {
      const uri = doc.uri.toString();
      if (!this.waiting.has(uri)) return [];
      const at = new vscode.Range(0, 0, 0, 0);
      const lens = (title: string, tooltip: string, event?: ReviewEvent) =>
        new vscode.CodeLens(at, {
          title,
          tooltip,
          command: 'reviewDesk.github.postAs',
          arguments: [uri, event],
        });
      return [
        lens(
          '$(cloud-upload) Post as Comment',
          'Post the review as it reads below, as comments',
          'COMMENT',
        ),
        lens('$(check) Approve', 'Post the review below and approve the pull request', 'APPROVE'),
        lens(
          '$(request-changes) Request Changes',
          'Post the review below and ask for changes',
          'REQUEST_CHANGES',
        ),
        lens('Cancel', 'Post nothing'),
      ];
    },
  };

  /** A button pressed: how to post the preview (undefined: Cancel). */
  answer(uri: string, event: ReviewEvent | undefined): void {
    this.waiting.get(uri)?.(event);
  }

  /**
   * Shows `preview` in an editor beside and waits for a button; closing it posts nothing.
   * Returns how to post and the text as the reviewer left it.
   */
  async show(preview: string): Promise<{ event: ReviewEvent; text: string } | undefined> {
    const doc = await vscode.workspace.openTextDocument({ content: preview, language: 'markdown' });
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
    const uri = doc.uri.toString();
    const event = await new Promise<ReviewEvent | undefined>((resolve) => {
      const closed = vscode.workspace.onDidCloseTextDocument((d) => {
        if (d.uri.toString() === uri) done(undefined);
      });
      // Its last tab closed: done too (the document itself may be closed only later), so the
      // post under way ends and another can start.
      const shown = (t: vscode.Tab) =>
        t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri;
      const tabs = vscode.window.tabGroups.onDidChangeTabs((e) => {
        if (!e.closed.some(shown)) return;
        if (!vscode.window.tabGroups.all.some((g) => g.tabs.some(shown))) done(undefined);
      });
      const done = (e: ReviewEvent | undefined) => {
        closed.dispose();
        tabs.dispose();
        this.waiting.delete(uri);
        this.lensesChanged.fire();
        resolve(e);
      };
      this.waiting.set(uri, done);
      this.lensesChanged.fire();
    });
    const text = doc.getText();
    if (!doc.isClosed) {
      // Done with it: close it without asking to save.
      await vscode.window.showTextDocument(doc, editor.viewColumn);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    return event && { event, text };
  }

  dispose(): void {
    this.lensesChanged.dispose();
  }
}
