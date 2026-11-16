import * as path from 'node:path';
import * as vscode from 'vscode';
import { isFileNote, KIND_LABELS, type ResolvedAnnotation } from '../review/model';
import type { ReviewTarget } from '../review/target';
import { toGitUri } from './gitApi';

const STATE_LABELS = { ok: '', moved: ' · moved', stale: ' · outdated' } as const;

/**
 * Shows each annotation as a read-only comment thread by Claude. This is the simple
 * display from M1; the side panel replaces it later and it stays behind a setting.
 */
export class CommentThreads implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(
    'reviewDesk',
    'Review Desk',
  );
  private threads: vscode.CommentThread[] = [];

  get count(): number {
    return this.threads.length;
  }

  set(target: ReviewTarget | undefined, annotations: ResolvedAnnotation[]): void {
    this.clear();
    if (!target) return;
    for (const a of annotations) {
      if (!a.file || isFileNote(a)) continue;
      const uri = this.uriFor(target, a);
      if (!uri) continue;
      const range = new vscode.Range(a.resolvedStart - 1, 0, a.resolvedEnd - 1, 0);
      const body = new vscode.MarkdownString(`**${a.number}. ${a.title}**\n\n${a.body}`);
      const comment: vscode.Comment = {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: 'Claude' },
        label: KIND_LABELS[a.kind] + STATE_LABELS[a.state],
      };
      const thread = this.controller.createCommentThread(uri, range, [comment]);
      thread.canReply = false;
      thread.label = `${a.number}. ${KIND_LABELS[a.kind]}`;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.contextValue = a.id;
      this.threads.push(thread);
    }
  }

  private uriFor(target: ReviewTarget, a: ResolvedAnnotation): vscode.Uri | undefined {
    if (a.side === 'new') return vscode.Uri.file(path.join(target.root, a.file));
    const f = target.files.find((x) => x.newPath === a.file || x.oldPath === a.file);
    const oldPath = f?.oldPath ?? a.file;
    return toGitUri(vscode.Uri.file(path.join(target.root, oldPath)), target.base.sha);
  }

  private clear(): void {
    for (const t of this.threads) t.dispose();
    this.threads = [];
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}
