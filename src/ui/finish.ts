import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import {
  deleteMergedBranch,
  homeBranch,
  homeRef,
  mergedInto,
  updateHome,
  type HomeBranch,
} from '../review/homeBranch';
import { samePath } from '../review/realpath';
import type { ReviewTarget } from '../review/target';
import {
  listWorktrees,
  refKind,
  removalProblem,
  removeWorktree,
  worktreeOf,
  type WorktreeInfo,
} from '../review/worktree';
import { checkOut } from './place';
import {
  closeWorktreeEditors,
  ignoredNote,
  leaveWindow,
  unpushedNote,
  windowNote,
} from './worktreeRemoval';
import type { Prompts } from './prompts';
import { errorText, showWarning } from './log';

/** What finishing a review did, for the caller (and tests) to tell. */
export type Finished =
  | { done: false; why: string }
  | { done: true; home: string; deleted?: string; behind?: boolean }
  | { done: true; openedWindow: string }
  | { done: true; worktree: string; removed: boolean; deleted?: string };

/**
 * How to finish without asking (tests): switch to the default branch, and delete the
 * reviewed branch too; for a review in a worktree, remove it, and delete the branch too,
 * or only close the review.
 */
export type FinishChoice = 'switch' | 'delete' | 'remove' | 'keep';

/**
 * Finishes the review: brings the repository's default branch (main) up to date with its
 * remote, switches this window to it and closes the review; its notes stay in Saved
 * Reviews. When every commit of the reviewed branch is in main (a PR merged with a merge
 * commit), it offers to delete that branch too. Uncommitted changes are asked about first;
 * main checked out in another worktree is opened in that worktree's window instead.
 * A review in a worktree of its own removes the worktree instead (see `finishWorktree`).
 */
export async function finishReview(
  controller: ReviewController,
  prompts: Prompts,
  choice?: FinishChoice,
): Promise<Finished> {
  const t = controller.target;
  const say = (why: string): Finished => {
    void vscode.window.showInformationMessage(`Review Desk: ${why}`);
    return { done: false, why };
  };
  if (!t) return say('no review is open.');
  const root = t.root;
  const home = await homeBranch(root);
  const branch = (await refKind(root, t.head.ref)) === 'local' ? t.head.ref : undefined;
  // A linked worktree (one made for a branch or a pull request): removed, not switched; the
  // repository's own folder is where the default branch is.
  const worktrees = await listWorktrees(root).catch((): WorktreeInfo[] => []);
  const info = worktrees.find((w) => samePath(w.path, root));
  if (info && !info.main && worktrees[0]) {
    return finishWorktree(
      controller,
      prompts,
      { t, repo: worktrees[0].path, info, home, branch },
      choice,
    );
  }
  if (!home) return say('could not tell the default branch (no origin/HEAD, main or master).');
  if (branch === home.branch) {
    controller.close();
    return { done: true, home: home.branch };
  }

  // Already checked out in another worktree: that window is where main is.
  const holder = await worktreeOf(root, home.branch);
  if (holder && !samePath(holder, root)) {
    const open = await prompts.confirm(
      `${home.branch} is checked out in the worktree ${path.basename(holder)}, so this window cannot switch to it. Open that window?`,
      'Open Its Window',
      'This window and its review stay as they are.',
    );
    if (!open) return { done: false, why: 'cancelled' };
    await prompts.openFolder(holder);
    return { done: true, openedWindow: holder };
  }

  const upToDate = await prompts.progress(`Fetching ${homeRef(home)}…`, () =>
    updateHome(root, home),
  );
  const local = (await refKind(root, home.branch)) === 'local';
  const into = local ? home.branch : homeRef(home);
  const merged = !!branch && (await mergedInto(root, branch, into));
  const name = branch ?? `detached ${t.head.ref}`;
  const switchOnly = `Switch to ${home.branch}`;
  const andDelete = `Switch and Delete ${branch}`;
  const picked =
    choice === 'switch'
      ? switchOnly
      : choice === 'delete'
        ? merged
          ? andDelete
          : undefined
        : await prompts.choose(
            `Finish the review of ${name}? This window switches to ${home.branch}${upToDate && home.remote ? `, up to date with ${homeRef(home)}` : ''}, and the review closes. Its notes stay in Saved Reviews.`,
            merged ? [andDelete, switchOnly] : [switchOnly],
            merged
              ? `Every commit of ${branch} is in ${home.branch}, so deleting the branch loses nothing.`
              : branch
                ? `${branch} has commits ${home.branch} does not (or it was squashed into it), so it is kept.`
                : undefined,
          );
  if (!picked) return { done: false, why: choice === 'delete' ? 'not merged' : 'cancelled' };

  const out = await checkOut(
    { root, ref: local ? home.branch : homeRef(home), name: home.branch, place: 'here', start: {} },
    prompts,
  );
  if (!out) return { done: false, why: 'cancelled' };
  controller.close();
  let deleted: string | undefined;
  if (picked === andDelete && branch) {
    try {
      await deleteMergedBranch(root, branch, into);
      deleted = branch;
    } catch (e) {
      showWarning(`Review Desk: could not delete ${branch}. ${errorText(e)}`, e);
    }
  }
  // A local main that could not move forward (it has commits of its own): say so.
  const behind = !!home.remote && local && !upToDate;
  void vscode.window.showInformationMessage(
    `Review Desk: back on ${home.branch}${behind ? ` (behind ${homeRef(home)}: pull to bring it up to date)` : ''}.${deleted ? ` ${deleted} deleted.` : ''} The review's notes are in Saved Reviews.`,
  );
  return { done: true, home: home.branch, deleted, behind };
}

/**
 * Finishes a review in a linked worktree: removes the worktree (its folder, ignored files
 * too) after the checks the Worktrees list makes, with the branch when every commit of it
 * is in the default branch, and closes the review; its notes stay in Saved Reviews. The
 * worktree's editors close first; then the folder leaves this window, or, when it is the
 * window's only folder, the window closes. Or only the review closes, the worktree kept.
 */
async function finishWorktree(
  controller: ReviewController,
  prompts: Prompts,
  w: { t: ReviewTarget; repo: string; info: WorktreeInfo; home?: HomeBranch; branch?: string },
  choice?: FinishChoice,
): Promise<Finished> {
  const { t, repo, info, home, branch } = w;
  const name = path.basename(t.root);
  const what = branch ?? `detached ${t.head.sha.slice(0, 7)}`;
  const problem = await removalProblem(repo, info).catch((e: unknown) => errorText(e));
  let merged = false;
  // Where its commits count as merged: the remote's default branch, which a local one
  // checked out in the repository's folder can lag behind (it is not moved forward there).
  const into = home && (home.remote ? homeRef(home) : home.branch);
  // The home branch itself (main checked out in this worktree) is never offered for deletion.
  if (home && into && branch && branch !== home.branch && !problem) {
    await prompts.progress(`Fetching ${homeRef(home)}…`, () => updateHome(repo, home));
    merged = await mergedInto(repo, branch, into);
  }
  const ignored = problem ? '' : await ignoredNote(t.root);
  const unpushed = problem ? '' : await unpushedNote(repo, branch);
  const remove = 'Remove Worktree';
  const removeAndDelete = `Remove Worktree and Delete ${branch}`;
  const keep = 'Close Review Only';
  const buttons = problem ? [keep] : merged ? [removeAndDelete, remove, keep] : [remove, keep];
  const picked =
    choice === 'keep'
      ? keep
      : choice === 'remove'
        ? problem
          ? undefined
          : remove
        : choice === 'delete'
          ? merged
            ? removeAndDelete
            : undefined
          : choice === 'switch'
            ? undefined
            : await prompts.choose(
                problem
                  ? `Finish the review of ${what}? The worktree ${name} cannot be removed: ${problem}`
                  : `Finish the review of ${what}? The worktree ${name} is removed: its folder ${t.root} is deleted, ignored files (such as node_modules) too.${ignored}${unpushed}${windowNote(t.root)} The review closes; its notes stay in Saved Reviews.`,
                buttons,
                problem
                  ? 'Close Review Only keeps the worktree.'
                  : merged
                    ? `Every commit of ${branch} is in ${home!.branch}, so deleting the branch loses nothing.`
                    : branch
                      ? `The branch ${branch} and its commits stay.`
                      : 'Its commits stay.',
              );
  if (!picked) return { done: false, why: problem ?? (choice ? 'not merged' : 'cancelled') };

  if (picked === keep) {
    controller.close();
    return { done: true, worktree: t.root, removed: false };
  }
  if (!(await closeWorktreeEditors(controller, t.root))) {
    return { done: false, why: 'an editor with unsaved changes was kept open' };
  }
  try {
    await removeWorktree(repo, info);
  } catch (e) {
    showWarning(`Review Desk: could not remove the worktree ${name}. ${errorText(e)}`, e);
    return { done: false, why: errorText(e) };
  }
  let deleted: string | undefined;
  if (picked === removeAndDelete && branch && into) {
    try {
      await deleteMergedBranch(repo, branch, into);
      deleted = branch;
    } catch (e) {
      showWarning(`Review Desk: could not delete ${branch}. ${errorText(e)}`, e);
    }
  }
  void vscode.window.showInformationMessage(
    `Review Desk: removed the worktree ${name}.${deleted ? ` ${deleted} deleted.` : ''} The review's notes are in Saved Reviews.`,
  );
  await leaveWindow(prompts, t.root);
  return { done: true, worktree: t.root, removed: true, deleted };
}
