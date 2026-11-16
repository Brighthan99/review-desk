import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { gitOrNull } from '../review/git';
import { DELETED, rightBlobs } from '../review/viewed';
import { showWarning } from './log';

/** Documents of git blobs: the version of a file a reviewer viewed. */
export const BLOB_SCHEME = 'review-desk-blob';

export function blobUri(file: string, blob: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BLOB_SCHEME, path: `/${file}`, query: blob });
}

export class BlobDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly controller: ReviewController) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const root = this.controller.target?.root;
    if (!root || uri.query === DELETED) return '';
    return (await gitOrNull(root, ['cat-file', 'blob', uri.query])) ?? '';
  }
}

/** The changed file a command is about: a list row, a path, or the file in the editor. */
export function fileOf(controller: ReviewController, arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  // A Uri (the editor title's button passes the editor's) has a string `path` too, the
  // absolute one: it is told apart first, or it reads as a list row's repository path.
  if (
    !(arg instanceof vscode.Uri) &&
    arg &&
    typeof arg === 'object' &&
    'path' in arg &&
    typeof arg.path === 'string'
  )
    return arg.path;
  const target = controller.target;
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  if (!target || uri?.scheme !== 'file') return undefined;
  const rel = path.relative(target.root, uri.fsPath).split(path.sep).join('/');
  return rel && !rel.startsWith('..') ? rel : undefined;
}

/** Diffs the version of a file marked viewed with the right side now: what changed since. */
export async function diffSinceViewed(
  controller: ReviewController,
  file: string,
): Promise<boolean> {
  const target = controller.target;
  const seen = controller.review?.viewed?.[file];
  if (!target || !seen) {
    void vscode.window.showInformationMessage(
      `Review Desk: ${file} is not marked viewed, so there is no version to compare with.`,
    );
    return false;
  }
  if (
    seen.blob !== DELETED &&
    (await gitOrNull(target.root, ['cat-file', '-e', seen.blob])) === null
  ) {
    showWarning(
      `Review Desk: the version of ${file} you viewed is no longer in the repository (git gc removed it).`,
    );
    return false;
  }
  const abs = path.join(target.root, file);
  const now = target.workTree
    ? fs.existsSync(abs)
      ? vscode.Uri.file(abs)
      : blobUri(file, DELETED)
    : blobUri(file, (await rightBlobs(target, [file])).get(file) ?? DELETED);
  await vscode.commands.executeCommand(
    'vscode.diff',
    blobUri(file, seen.blob),
    now,
    `${path.posix.basename(file)} (viewed ${new Date(seen.at).toLocaleString()} ↔ now)`,
  );
  return true;
}
