import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { samePath } from '../review/realpath';
import type { Repo } from '../review/repos';
import { finishReview, type FinishChoice } from '../ui/finish';
import { diffSinceViewed, fileOf } from '../ui/viewedFiles';
import { removeCommand, type WorktreeRow } from '../ui/worktreesTree';
import type { Command, Services } from './services';

/**
 * The side bar lists: the Review list (how it shows the files, files viewed), Saved Reviews
 * and Worktrees; and the review itself (restart, close, its file).
 */
export function registerListCommands(command: Command, s: Services): void {
  const { controller, tree, saved, worktrees, prompts, start } = s;
  command('reviewDesk.start', start);
  command('reviewDesk.closeReview', () => controller.close());
  // Back to main: switch to it (up to date), close the review, maybe delete the merged branch.
  command('reviewDesk.finishReview', (choice?: FinishChoice) =>
    finishReview(controller, prompts, choice),
  );
  command('reviewDesk.openReviewFile', () => openReviewFile(controller));
  // Several folders in the window: the one a review starts in, picked in the list; or a review
  // started in one (its row's ▷ button, the first row of a review, the command palette).
  command('reviewDesk.chooseFolder', async (root: string) => {
    const repo = (await controller.folders.load()).find((r) => r.root === root);
    if (!repo || !reviewable(repo)) return false;
    controller.folders.choose(repo.root);
    return true;
  });
  command('reviewDesk.startInFolder', async (arg?: string | { repo?: Repo }) => {
    const repos = await controller.folders.load();
    const root = typeof arg === 'string' ? arg : arg?.repo?.root;
    const repo = root
      ? repos.find((r) => r.root === root)
      : await prompts.pickFolder(repos, controller.target?.root);
    if (!repo || !reviewable(repo)) return false;
    const current = controller.target;
    if (current && samePath(current.root, repo.root)) return true;
    // Closed first: a review of another repository carries nothing over to this one.
    if (current) controller.close();
    return start({ cwd: repo.root });
  });

  command('reviewDesk.tree.showOrder', () => tree.setMode('order'));
  command('reviewDesk.tree.showReading', () => tree.setMode('reading'));
  command('reviewDesk.tree.showFolders', () => tree.setMode('folder'));
  command('reviewDesk.tree.showAll', () => tree.setShowAll(true));
  command('reviewDesk.tree.showChanged', () => tree.setShowAll(false));
  command('reviewDesk.tree.moreCommits', () => tree.showMoreCommits());
  command('reviewDesk.tree.expandAll', () => tree.expandAll());
  command('reviewDesk.tree.collapseAll', () => tree.collapseAll());
  command('reviewDesk.hideViewed', () => tree.setHideViewed(true));
  command('reviewDesk.showViewed', () => tree.setHideViewed(false));
  const viewedFile = (arg: unknown) => {
    const file = fileOf(controller, arg);
    const changed = file && controller.target?.files.some((f) => (f.newPath ?? f.oldPath) === file);
    if (!changed) {
      void vscode.window.showInformationMessage(
        'Review Desk: open a changed file of the review (or pick one in the list) first.',
      );
      return undefined;
    }
    return file;
  };
  command('reviewDesk.markViewed', async (arg: unknown) => {
    const file = viewedFile(arg);
    return !!file && (await controller.setViewed([file], true));
  });
  command('reviewDesk.markNotViewed', async (arg: unknown) => {
    const file = viewedFile(arg);
    return !!file && (await controller.setViewed([file], false));
  });
  command('reviewDesk.diffSinceViewed', async (arg: unknown) => {
    const file = viewedFile(arg);
    return !!file && (await diffSinceViewed(controller, file));
  });

  command('reviewDesk.openReview', (root: string, branch: string) => saved.open(root, branch));
  // From the list's trash icon VS Code passes the row (none when the list was being redrawn
  // as it was clicked); tests pass (root, branch).
  command(
    'reviewDesk.deleteReview',
    (
      row?: { repo: { root: string }; saved: { review: { head: { ref: string } } } } | string,
      branch?: string,
    ) => {
      if (typeof row === 'string') return saved.delete(row, branch!);
      if (row) return saved.delete(row.repo.root, row.saved.review.head.ref);
      void vscode.window.showInformationMessage(
        'Review Desk: the Saved Reviews list was being redrawn as you clicked. Click the trash icon again.',
      );
      return false;
    },
  );
  command('reviewDesk.refreshReviews', () => saved.refresh());

  command('reviewDesk.refreshWorktrees', () => worktrees.refresh());
  // The buttons of a row get the row from VS Code; none when the list was being redrawn as one
  // was clicked (see WorktreesTree.refresh): say so instead of failing.
  const onRow =
    <T>(run: (row: WorktreeRow) => T) =>
    (node?: { row?: WorktreeRow }): T | undefined => {
      if (node?.row) return run(node.row);
      void vscode.window.showInformationMessage(
        'Review Desk: the Worktrees list was being redrawn as you clicked. Click the button again.',
      );
      return undefined;
    };
  // Removes a worktree after checking nothing would be lost, else says why it cannot.
  command(
    'reviewDesk.removeWorktree',
    onRow((row) => worktrees.remove(row)),
  );
  // Or remove it by hand in a terminal (with --force, uncommitted work is lost).
  command(
    'reviewDesk.copyWorktreeRemove',
    onRow(async (row) => {
      const cmd = removeCommand(row);
      await vscode.env.clipboard.writeText(cmd);
      void vscode.window.showInformationMessage(
        `Review Desk: copied "${cmd}". Run it in a terminal${row.info.prunable ? '' : '; with uncommitted changes in the worktree, git asks for --force, which discards them'}.`,
      );
      return cmd;
    }),
  );
  // In a new window, whose review starts there.
  command(
    'reviewDesk.openWorktree',
    onRow((row) => worktrees.open(row)),
  );
  // Added to this window (unless it is one of its folders) and reviewed: the row's click too.
  command(
    'reviewDesk.reviewWorktree',
    onRow((row) => worktrees.review(row)),
  );
  // Only added next to this window's folders; a review starts in it from the Review list.
  command(
    'reviewDesk.addWorktreeToWindow',
    onRow((row) => prompts.addFolder(row.info.path)),
  );
}

async function openReviewFile(controller: ReviewController): Promise<void> {
  const { target, store } = controller;
  if (!target || !store) {
    void vscode.window.showInformationMessage('Review Desk: start a review first.');
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(store.reviewPath(target.head.sha)));
}

/** Whether a review can start in `repo`; says why not when it can't (a new repository). */
function reviewable(repo: Repo): boolean {
  if (repo.sha) return true;
  void vscode.window.showInformationMessage(
    `Review Desk: ${path.basename(repo.root)} has no commits yet, so there is nothing to review.`,
  );
  return false;
}
