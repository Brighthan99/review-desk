import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { workspaceForm, type ReviewController } from '../controller';
import { gitOrNull } from '../review/git';
import { listSavedReviews, type SavedReview } from '../review/savedReviews';
import { storeDir } from '../review/store';
import { samePath } from '../review/realpath';
import { listWorktrees, refKind } from '../review/worktree';
import { errorText, logRapid, showError } from './log';
import { checkOut } from './place';
import type { Prompts } from './prompts';

interface Repo {
  root: string;
  gitDir: string;
  reviews: SavedReview[];
  /** Branches checked out in other worktrees of the repository, with their folders. */
  elsewhere: Map<string, string>;
}

type Node = { kind: 'repo'; repo: Repo } | { kind: 'review'; repo: Repo; saved: SavedReview };

const notes = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`;

function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * The reviews saved in the workspace's repositories, one per branch, so a review can be
 * picked up again later: click to reopen (switching to its branch if needed), or delete.
 */
export class SavedReviewsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private repos: Repo[] = [];
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  /** Repository root and git dir of each workspace folder (null: not in a repository). */
  private readonly folderRepos = new Map<string, { root: string; gitDir: string } | null>();
  /** What the rows showed at the last refresh (see `shownKey`). */
  private shown = '';

  constructor(
    private readonly controller: ReviewController,
    private readonly prompts: Prompts,
  ) {
    this.subscriptions = [
      controller.onDidChange(() => {
        // A recomputed diff or an edited note changes nothing these rows show.
        const key = this.shownKey();
        if (key === this.shown) return;
        this.shown = key;
        this.refresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.folderRepos.clear();
        this.refresh();
      }),
      this.changed,
    ];
  }

  /** The open review as the rows show it: which one, its base and its number of notes. */
  private shownKey(): string {
    const t = this.controller.target;
    const r = this.controller.review;
    return t ? [t.root, t.head.sha, t.head.ref, r?.base.ref, r?.annotations.length].join('\n') : '';
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** The repositories of the workspace folders, with their saved reviews. */
  private async load(): Promise<Repo[]> {
    const repos = new Map<string, Repo>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const repo = await this.repoOf(folder.uri.fsPath);
      if (!repo || repos.has(repo.root)) continue;
      // The reviews of every worktree of the repository are kept together.
      const elsewhere = new Map<string, string>();
      for (const w of await listWorktrees(repo.root).catch(() => [])) {
        if (w.branch && !w.prunable && !samePath(w.path, repo.root))
          elsewhere.set(w.branch, w.path);
      }
      repos.set(repo.root, {
        ...repo,
        reviews: listSavedReviews(storeDir(repo.gitDir)),
        elsewhere,
      });
    }
    return [...repos.values()].filter((r) => r.reviews.length);
  }

  private readonly rapid = logRapid('Saved Reviews');

  private async repoOf(folder: string): Promise<{ root: string; gitDir: string } | null> {
    if (this.folderRepos.has(folder)) return this.folderRepos.get(folder)!;
    const top = await gitOrNull(folder, ['rev-parse', '--show-toplevel']);
    const root = top ? workspaceForm(top.trim()) : undefined;
    const gitDir = root && (await gitOrNull(root, ['rev-parse', '--absolute-git-dir']))?.trim();
    const repo = root && gitDir ? { root, gitDir } : null;
    // A folder that is not a repository yet may become one; ask again next time.
    if (repo) this.folderRepos.set(folder, repo);
    return repo;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) this.rapid();
    if (node?.kind === 'repo') {
      return node.repo.reviews.map((saved) => ({ kind: 'review', repo: node.repo, saved }));
    }
    if (node) return [];
    this.repos = await this.load();
    // One repository: its reviews directly. Several: a folder per repository.
    if (this.repos.length === 1) return this.getChildren({ kind: 'repo', repo: this.repos[0] });
    return this.repos.map((repo) => ({ kind: 'repo', repo }));
  }

  private isOpen(repo: Repo, saved: SavedReview): boolean {
    const t = this.controller.target;
    return !!t && t.root === repo.root && t.head.ref === saved.review.head.ref;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(
        path.basename(node.repo.root),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon('repo');
      item.id = `repo:${node.repo.root}`;
      return item;
    }
    const { review, updated } = node.saved;
    const open = this.isOpen(node.repo, node.saved);
    const there = node.repo.elsewhere.get(review.head.ref);
    const pr = review.github;
    const item = new vscode.TreeItem(
      pr ? `#${pr.number} ${pr.title ?? review.head.ref}` : review.head.ref,
    );
    item.id = `review:${node.repo.root}:${review.head.ref}`;
    item.iconPath = new vscode.ThemeIcon(open ? 'eye' : pr ? 'github' : 'git-branch');
    item.description = [
      open ? 'open' : undefined,
      there ? `in ${path.basename(there)}` : undefined,
      pr?.state && pr.state !== 'open' ? `PR ${pr.state}` : undefined,
      `base: ${review.base.ref}`,
      notes(review.annotations.length),
      ago(updated),
    ]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = [
      `${review.base.ref} ↔ ${review.head.ref}`,
      pr ? pr.url : undefined,
      `${notes(review.annotations.length)}, last at ${review.head.sha.slice(0, 7)}`,
      `Updated ${new Date(updated).toLocaleString()}`,
      open
        ? 'Open now'
        : there
          ? `Checked out in the worktree ${there}: click to open its window`
          : 'Click to open this review',
    ]
      .filter(Boolean)
      .join('\n');
    item.contextValue = 'savedReview';
    item.command = {
      command: 'reviewDesk.openReview',
      title: 'Open Review',
      arguments: [node.repo.root, review.head.ref],
    };
    return item;
  }

  private find(root: string, branch: string): { repo: Repo; saved: SavedReview } | undefined {
    const repo = this.repos.find((r) => r.root === root);
    const saved = repo?.reviews.find((s) => s.review.head.ref === branch);
    return repo && saved ? { repo, saved } : undefined;
  }

  /**
   * Reopens a saved review here, switching to its branch first (after asking) when another
   * one is checked out; a branch another worktree has goes on in that worktree's window.
   */
  async open(root: string, branch: string): Promise<boolean> {
    if (!this.repos.length) this.repos = await this.load();
    const found = this.find(root, branch);
    if (!found) return false;
    const { review } = found.saved;
    // A branch deleted since: its last reviewed commit, detached.
    const ref = (await refKind(root, branch)) === 'local' ? branch : review.head.sha;
    const pending = { base: review.base.ref, workTree: review.workTree, github: review.github };
    let out;
    try {
      out = await checkOut(
        { root, ref, name: branch, place: 'here', start: pending, askFirst: true },
        this.prompts,
      );
    } catch (e) {
      showError(`Review Desk: could not switch to ${branch}. ${errorText(e)}`, e);
      return false;
    }
    if (!out) return false;
    if (!out.here) return true;
    return vscode.commands.executeCommand<boolean>('reviewDesk.start', {
      cwd: root,
      base: review.base.ref,
      workTree: review.workTree,
      carry: review,
      github: review.github,
    });
  }

  /** Deletes every review file of a branch, after asking. */
  async delete(root: string, branch: string): Promise<boolean> {
    const found = this.find(root, branch);
    if (!found) return false;
    const { saved, repo } = found;
    const ok = await this.prompts.confirm(
      `Delete the saved review of ${branch}? Its ${notes(saved.review.annotations.length)} and their conversations are removed.`,
      'Delete',
    );
    if (!ok) return false;
    if (this.isOpen(repo, saved)) this.controller.close();
    for (const file of saved.files) fs.rmSync(file, { force: true });
    this.refresh();
    return true;
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
  }
}
