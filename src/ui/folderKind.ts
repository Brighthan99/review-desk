import * as path from 'node:path';
import * as vscode from 'vscode';
import { isLinkedWorktree, mainFolderOf } from '../review/store';
import type { Sync } from '../review/sync';

/**
 * The color that tells how a branch stands against the remote (see Sync): green in sync,
 * yellow with commits to push (pushed or not before), blue with commits to pull, orange with
 * both. None with nothing to tell (no remote; every commit on one, but no branch of its own).
 */
export function syncColor(s: Sync | undefined): vscode.ThemeColor | undefined {
  if (!s || (!s.remote && !s.ahead)) return undefined;
  const id =
    s.ahead && s.behind
      ? 'charts.orange'
      : s.ahead
        ? 'charts.yellow'
        : s.behind
          ? 'charts.blue'
          : 'charts.green';
  return new vscode.ThemeColor(id);
}

/**
 * With commits to push or pull, the arrow that says which: up to push, down to pull, the
 * circling arrows of VS Code's Sync Changes for both. None otherwise: the folder's own icon.
 */
function syncArrow(s: Sync | undefined): string | undefined {
  if (!s) return undefined;
  if (s.ahead && s.behind) return 'sync';
  if (s.ahead) return 'arrow-up';
  if (s.behind) return 'arrow-down';
  return undefined;
}

/**
 * A folder among folders: a repository's own folder, or a git worktree made from one. With
 * commits to push or pull, an arrow instead; colored by how its branch stands (syncColor).
 */
export function folderIcon(worktree: boolean, sync?: Sync): vscode.ThemeIcon {
  return new vscode.ThemeIcon(syncArrow(sync) ?? (worktree ? 'worktree' : 'repo'), syncColor(sync));
}

/** The row of the branch a folder has out: the branch, or the worktree it is in; as above. */
export function branchIcon(worktree: boolean, sync?: Sync): vscode.ThemeIcon {
  return new vscode.ThemeIcon(
    syncArrow(sync) ?? (worktree ? 'worktree' : 'git-branch'),
    syncColor(sync),
  );
}

/** Which kind of folder has the git dir `gitDir`, for a tooltip. */
export function folderKindNote(gitDir: string): string {
  return isLinkedWorktree(gitDir)
    ? `A git worktree of ${path.basename(mainFolderOf(gitDir))}.`
    : "The repository's own folder, not a git worktree.";
}
