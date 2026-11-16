import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { realpath, samePath } from '../review/realpath';
import { ignoredToKeep, unpushedCount } from '../review/worktree';
import { reviewTitle } from './diffView';
import type { Prompts } from './prompts';

/** Where a worktree's folder is in this window: its only folder, one of several, or not here. */
export function windowPlace(dir: string): 'only' | 'one' | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.some((f) => samePath(f.uri.fsPath, dir))) return undefined;
  return folders.length === 1 ? 'only' : 'one';
}

/** What removing a worktree does to this window, for the question asked first. */
export function windowNote(dir: string): string {
  const place = windowPlace(dir);
  return place === 'only'
    ? ' This window closes, since the worktree is its folder.'
    : place === 'one'
      ? " It leaves this window's folders."
      : '';
}

/** The ignored files removing the worktree `dir` deletes for good, for the question asked first. */
export async function ignoredNote(dir: string): Promise<string> {
  const keep = await ignoredToKeep(dir);
  if (!keep.length) return '';
  const more = keep.length > 5 ? `, and ${keep.length - 5} more` : '';
  return ` Ignored files no build or install makes again go too: ${keep.slice(0, 5).join(', ')}${more}. Copy them elsewhere first if they are needed.`;
}

/**
 * The commits of a worktree's branch no remote has, for the question asked first: removing
 * the worktree keeps them on the branch, but only this repository has them.
 */
export async function unpushedNote(repo: string, branch: string | undefined): Promise<string> {
  const n = branch ? await unpushedCount(repo, branch) : undefined;
  if (!n) return '';
  return ` ${branch} has ${n} ${n === 1 ? 'commit' : 'commits'} not pushed to any remote: only this repository has ${n === 1 ? 'it' : 'them'}.`;
}

/**
 * Before a worktree's folder goes: closes the editors of its files, diffs included, so none is
 * left showing deleted files, then the review on it. False when the reviewer kept a tab open
 * (Cancel in the dialog asking to save its changes): the worktree must stay then.
 */
export async function closeWorktreeEditors(
  controller: ReviewController,
  dir: string,
): Promise<boolean> {
  const t = controller.target;
  const reviewed = !!t && samePath(t.root, dir);
  const tabs = tabsIn(dir, reviewed ? reviewTitle(t) : undefined);
  if (tabs.length && !(await vscode.window.tabGroups.close(tabs, true))) return false;
  if (reviewed) controller.close();
  return true;
}

/**
 * After a worktree's folder went: takes it out of this window's folders, or closes the
 * window when it was the only one. Callers do this last: taking out the window's first
 * folder restarts the extensions.
 */
export async function leaveWindow(prompts: Prompts, dir: string): Promise<void> {
  const place = windowPlace(dir);
  if (place === 'only') await prompts.closeWindow();
  else if (place === 'one') await prompts.removeFolder(dir);
}

/** The tabs showing files of `dir` (diffs too), and the review's changes editor (`title`). */
function tabsIn(dir: string, title?: string): vscode.Tab[] {
  const root = realpath(dir);
  const inside = (u: vscode.Uri | undefined) => {
    if (!u || (u.scheme !== 'file' && u.scheme !== 'git')) return false;
    const rel = path.relative(root, realpath(u.fsPath));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((tab) => {
      const input = tab.input;
      if (input instanceof vscode.TabInputText) return inside(input.uri);
      if (input instanceof vscode.TabInputTextDiff) {
        return inside(input.original) || inside(input.modified);
      }
      // The changes editor's tab adds how many files: `Review: main ↔ feat/x (3 files)`.
      return !!title && (tab.label === title || tab.label.startsWith(`${title} (`));
    });
}
