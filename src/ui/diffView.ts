import * as path from 'node:path';
import * as vscode from 'vscode';
import { filePath } from '../review/diffParser';
import type { ReviewTarget } from '../review/target';
import { toGitUri } from './gitApi';

export function reviewTitle(target: ReviewTarget): string {
  return `Review: ${target.base.ref} ↔ ${target.head.ref}`;
}

/**
 * Opens every changed file in one multi-file diff editor. The original side is the base
 * commit (`git:` URI); the modified side is the working tree file, so the real editor features
 * work there. Without `reviewDesk.includeUncommitted` that side shows uncommitted edits the
 * review does not include.
 */
export async function openChanges(target: ReviewTarget): Promise<void> {
  const resources = target.files.map(
    (f): [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined] => {
      const label = vscode.Uri.file(path.join(target.root, filePath(f)));
      const original =
        f.oldPath === null
          ? undefined
          : toGitUri(vscode.Uri.file(path.join(target.root, f.oldPath)), target.base.sha);
      const modified =
        f.newPath === null ? undefined : vscode.Uri.file(path.join(target.root, f.newPath));
      return [label, original, modified];
    },
  );
  await vscode.commands.executeCommand('vscode.changes', reviewTitle(target), resources);
}

/**
 * Opens a file of the review at a line: a two-sided diff when it changed, a plain editor
 * otherwise. By default a preview in the first column, so a click in the side panel does
 * not replace the panel; `show` overrides that.
 */
export async function openFileAt(
  target: ReviewTarget,
  file: string,
  line?: number,
  show: vscode.TextDocumentShowOptions = {},
): Promise<void> {
  const f = target.files.find((x) => filePath(x) === file || x.oldPath === file);
  const options: vscode.TextDocumentShowOptions = {
    preview: true,
    preserveFocus: true,
    viewColumn: vscode.ViewColumn.One,
    selection: line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined,
    ...show,
  };
  if (!f || f.oldPath === null || f.newPath === null) {
    const p = f?.newPath ?? f?.oldPath ?? file;
    const uri =
      f?.newPath === null
        ? toGitUri(vscode.Uri.file(path.join(target.root, p)), target.base.sha)
        : vscode.Uri.file(path.join(target.root, p));
    await vscode.window.showTextDocument(uri, options);
    return;
  }
  const left = toGitUri(vscode.Uri.file(path.join(target.root, f.oldPath)), target.base.sha);
  const right = vscode.Uri.file(path.join(target.root, f.newPath));
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${f.newPath} (review)`,
    options,
  );
}
