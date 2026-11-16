import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { newReplies } from './github/replies';
import { resolveAnnotations } from './review/anchor';
import { git, gitOrNull } from './review/git';
import { allIgnored } from './review/ignored';
import { realpath } from './review/realpath';
import { recordedBase, type BaseChoice, type BaseSource } from './review/branchBase';
import type { Annotation, GitHubInfo, ResolvedAnnotation, Review } from './review/model';
import { listSavedReviews, pruneBranchReviews, type SavedReview } from './review/savedReviews';
import { readReviewFile, ReviewStore } from './review/store';
import { fetchAll } from './review/fetch';
import { GitDirWatch } from './review/gitDirWatch';
import {
  computeTarget,
  diffDigest,
  repoRoot,
  TargetError,
  type ReviewTarget,
} from './review/target';
import { rightBlobs, viewedStates, type ViewedState } from './review/viewed';
import { CommentThreads } from './ui/comments';
import { setting } from './settings';
import { log, showError, showWarning } from './ui/log';
import type { Prompts } from './ui/prompts';
import { ReviewDecorator } from './ui/decorations';
import { RepoFolders } from './ui/folders';
import { openChanges } from './ui/diffView';

export interface StartOptions {
  /**
   * Base ref. Without one: the branch's open PR target, its recorded PR target
   * (gh-merge-base), its last review's base, the `reviewDesk.baseRef` setting, then the
   * default branch.
   */
  base?: string;
  /** Where `base` came from, for display (default: picked). */
  baseSource?: BaseSource;
  /** Open the multi-file diff editor (default true). */
  open?: boolean;
  /** The GitHub PR this review is for. */
  github?: GitHubInfo;
  /** A folder inside the repository to review; defaults to the active editor's folder. */
  cwd?: string;
  /**
   * The compare side: the working tree, uncommitted edits included (true), or HEAD only (false).
   * Default: the review's own choice when it continues, else `reviewDesk.includeUncommitted`.
   */
  workTree?: boolean;
  /** Without a base branch, review HEAD alone (no diff) so files can still be explained. */
  orHead?: boolean;
  /**
   * A saved review of this branch to continue: when HEAD has moved since, its notes are
   * carried to the new head (as when the open review follows a commit).
   */
  carry?: Review;
}

/** Owns the current review: target diff, review file, resolved annotations and their display. */
/** The heads a branch had, from its reflog; undefined when there is none to read. */
async function branchHeads(root: string, branch: string): Promise<Set<string> | undefined> {
  const out = await gitOrNull(root, ['reflog', 'show', '--format=%H', `refs/heads/${branch}`]);
  const shas = out?.split('\n').filter(Boolean);
  return shas?.length ? new Set(shas) : undefined;
}

/** Whether `ancestor` is `sha` or one of its ancestors. */
async function isAncestor(root: string, ancestor: string, sha: string): Promise<boolean> {
  return (await gitOrNull(root, ['merge-base', '--is-ancestor', ancestor, sha])) !== null;
}

/** What a change to a review returns when it changed nothing (see ReviewController.mutate). */
export const UNCHANGED: unique symbol = Symbol.for('reviewDesk.unchanged');

export class ReviewController implements vscode.Disposable {
  target: ReviewTarget | undefined;
  store: ReviewStore | undefined;
  review: Review | undefined;
  resolved: ResolvedAnnotation[] = [];
  /** Changed files marked viewed: still as viewed, or changed since. */
  viewed = new Map<string, ViewedState>();
  loadError: string | undefined;

  readonly decorator: ReviewDecorator;
  readonly comments = new CommentThreads();
  private readonly statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** Remote branches moved: fetched (by Fetch, VS Code's autofetch or a terminal), or pushed. */
  private readonly fetched = new vscode.EventEmitter<void>();
  readonly onDidFetch = this.fetched.event;
  private watcher: { dispose(): void } | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private headCheck: NodeJS.Timeout | undefined;
  private gitDirWatch: GitDirWatch | undefined;
  private workTreeWatcher: vscode.Disposable | undefined;
  private workTreeCheck: NodeJS.Timeout | undefined;

  constructor(storage: vscode.Uri) {
    this.decorator = new ReviewDecorator(storage);
    // No review yet: the list shows the window's branches.
    this.folders.setWatching(true);
    this.statusItem.command = 'reviewDesk.showActions';
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorator.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('reviewDesk.showCommentThreads')) this.render();
      }),
    );
  }

  /** Where the open review's base came from. */
  baseChoice: BaseChoice | undefined;
  /** Looks up the target branch of an open PR for a branch (set from the GitHub service). */
  prBase: ((root: string, branch: string) => Promise<BaseChoice | undefined>) | undefined;

  /** The window's repositories, and the one a review starts in (also shown with no review). */
  readonly folders = new RepoFolders();

  /** Folder to review: the chosen one (the last review's), the active editor's, the first. */
  workspaceCwd(): string | undefined {
    return this.folders.selected()?.root ?? this.folders.candidates()[0];
  }

  /** Starts in progress, and the latest one: starts overlap (a HEAD move during a PR checkout). */
  private starting = 0;
  private startGeneration = 0;
  /** Shows the review list busy while a start computes the review (set to `Prompts.progress`). */
  progress: Prompts['progress'] = (_title, task) => task();

  /**
   * Starts a review, or starts it again on another base, side or head (a switch followed):
   * the list shows its progress bar meanwhile.
   */
  async start(options: StartOptions = {}): Promise<boolean> {
    this.starting++;
    const generation = ++this.startGeneration;
    try {
      return await this.progress('Updating the review…', () =>
        this.startReview(options, generation),
      );
    } finally {
      this.starting--;
    }
  }

  private async startReview(options: StartOptions, generation: number): Promise<boolean> {
    log().info(
      `starting a review (base ${options.base ?? 'default'}, ${options.cwd ?? 'current folder'})`,
    );
    const cwd = options.cwd ?? this.target?.root ?? (await this.folders.startFolder());
    if (!cwd) {
      showWarning('Review Desk: no folder is open.');
      return false;
    }
    const configured = setting('baseRef') || undefined;
    let choice: BaseChoice | undefined = options.base
      ? { ref: options.base, source: options.baseSource ?? 'picked' }
      : ((await this.branchBase(cwd)) ??
        (configured ? { ref: configured, source: 'setting' } : undefined));
    const base = choice?.ref;
    const workTree = options.workTree ?? setting('includeUncommitted');
    let target: ReviewTarget;
    try {
      target = await computeTarget(cwd, base, { workTree }).catch((e: unknown) => {
        if (options.orHead && !base && e instanceof TargetError) {
          return computeTarget(cwd, 'HEAD', { workTree });
        }
        throw e;
      });
      target.root = workspaceForm(target.root);
    } catch (e) {
      const message = e instanceof TargetError ? e.message : String(e);
      showError(`Review Desk: ${message}`, e instanceof TargetError ? undefined : e);
      return false;
    }

    if (!workTree) {
      const dirty = (
        await git(target.root, ['status', '--porcelain', '--untracked-files=no'])
      ).trim();
      if (dirty) {
        showWarning(
          'Review Desk: there are uncommitted changes, so new-side line numbers may not match HEAD.',
        );
      }
    }

    choice ??= { ref: target.base.ref, source: 'default' };
    // A start called after this one wins (e.g. a PR's base over the old base of a HEAD move).
    if (generation !== this.startGeneration) return false;
    // The review open until now, to carry over after a commit on the same branch: only from
    // this same folder (its git dir), never another repository's on a branch of the same name.
    const sameFolder = this.target?.gitDir === target.gitDir;
    // As stored (a note saved by the chat a moment ago may not be loaded yet).
    const previous = sameFolder ? (this.storedReview() ?? this.review) : undefined;
    // The review file is ready (the notes carried over) before the review shows this head: a
    // note added at once (an answer arriving) goes into it then, not into nothing.
    const store = new ReviewStore(target.gitDir);
    await this.ensureReviewFile(store, target, options.carry ?? previous);
    if (generation !== this.startGeneration) return false;
    this.target = target;
    this.folders.choose(target.root);
    this.folders.setWatching(false);
    this.baseChoice = choice;
    this.store = store;
    const stored = this.store.load(target.head.sha);
    if (stored.kind === 'ok') {
      // Keep the base chosen now (a reload restores it), how the diff is taken (the chat's
      // MCP server takes it the same way), the branch's current name (a renamed branch keeps
      // its review, and the next commit carries the notes) and the PR this review is for.
      const r = stored.review;
      const baseChanged =
        r.base.ref !== target.base.ref ||
        r.base.sha !== target.base.sha ||
        r.workTree !== target.workTree;
      if (baseChanged) Object.assign(r, { base: target.base, workTree: target.workTree });
      const renamed = r.head.ref !== target.head.ref;
      if (renamed) r.head = target.head;
      if (options.github) r.github = { ...options.github, posted: r.github?.posted };
      if (baseChanged || renamed || options.github) this.store.save(r);
    }

    this.watcher?.dispose();
    this.watcher = this.store.watch(target.head.sha, () => {
      log().info('review file changed: reloading');
      void this.reload();
    });
    this.watchGitDir(target);
    this.watchWorkTree(target);
    await this.reload();
    // Closed (or started again) meanwhile: nothing more to show.
    if (generation !== this.startGeneration) return false;
    if (options.open !== false) {
      if (target.files.length) await openChanges(target);
      else {
        void vscode.window.showInformationMessage(
          `Review Desk: no changes against ${target.base.ref}. Select code in any file and run "Review Desk: Explain Code".`,
        );
      }
    }
    return true;
  }

  /**
   * Keeps a working tree review current: any file written on disk (by an editor, a formatter
   * or an agent) recomputes the diff, unless git ignores it. HEAD moves are handled by
   * watchGitDir.
   */
  private watchWorkTree(target: ReviewTarget): void {
    this.workTreeWatcher?.dispose();
    this.workTreeWatcher = undefined;
    if (!target.workTree) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(target.root), '**/*'),
    );
    const files = new Set<string>();
    const settle = async () => {
      const paths = [...files];
      files.clear();
      // Only ignored files (build output, test profiles, node_modules): the diff is the same.
      if (await allIgnored(target.root, paths)) return;
      log().info(
        `working tree changed (${paths.length} ${paths.length === 1 ? 'file' : 'files'}, first ${paths[0]}): refreshing the diff`,
      );
      await this.refreshTarget();
    };
    const changed = (uri: vscode.Uri) => {
      // Only files on disk: the watcher also hears other schemes, such as the git
      // extension's `git:` documents (the base versions opened to mark changed lines), which
      // it reports as changed after every git status, and a refresh reads them again.
      if (uri.scheme !== 'file' || uri.fsPath.split(path.sep).includes('.git')) return;
      files.add(uri.fsPath);
      clearTimeout(this.workTreeCheck);
      this.workTreeCheck = setTimeout(() => void settle(), 400);
    };
    watcher.onDidChange(changed);
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    this.workTreeWatcher = watcher;
  }

  /** The PR target a branch has: its open PR's, else the one on record. */
  private async branchBase(cwd: string): Promise<BaseChoice | undefined> {
    try {
      const root = await repoRoot(cwd);
      const branch = (await git(root, ['branch', '--show-current'])).trim();
      if (!branch) return undefined;
      const pr = await this.prBase?.(root, branch);
      if (pr) return pr;
      const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
      return await recordedBase(root, gitDir, branch);
    } catch {
      return undefined;
    }
  }

  /** Ends the review: clears its display and stops watching. Its review file is kept. */
  close(): void {
    // A start still running (computing the diff) would set the review up again after this.
    this.startGeneration++;
    clearTimeout(this.headCheck);
    clearTimeout(this.workTreeCheck);
    this.watcher?.dispose();
    this.gitDirWatch?.dispose();
    this.workTreeWatcher?.dispose();
    this.watcher = this.gitDirWatch = this.workTreeWatcher = undefined;
    this.target = this.store = this.review = this.loadError = undefined;
    // The list shows the window's branches again, starting from this repository.
    this.folders.setWatching(true);
    this.resolved = [];
    this.viewed = new Map();
    this.render();
    this.changed.fire();
  }

  /** Recomputes the diff of the open review (same base and head) and re-resolves the cards. */
  /** The latest refresh and reload started: an earlier one ending later must not undo it. */
  private refreshSeq = 0;
  private reloadSeq = 0;

  async refreshTarget(): Promise<void> {
    const current = this.target;
    if (!current) return;
    const seq = ++this.refreshSeq;
    try {
      const next = await computeTarget(current.root, current.base.ref, {
        workTree: current.workTree,
      });
      // A later refresh started meanwhile (the diff it computes is newer), or another review
      // opened: this one's result is stale. (Not `this.target !== current`: a refresh started
      // before this one, ending first, would replace the target and drop this newer result.)
      const now = this.target;
      if (
        seq !== this.refreshSeq ||
        !now ||
        now.gitDir !== current.gitDir ||
        now.base.ref !== current.base.ref ||
        now.workTree !== current.workTree
      ) {
        return;
      }
      if (next.head.sha !== current.head.sha) {
        // HEAD moved and no watcher noticed: follow it.
        this.scheduleHeadCheck();
        return;
      }
      // Nothing the review shows changed (an ignored file such as a build output, or only
      // file metadata): no reload, so the lists, the panel and the decorations stay as they are.
      if (sameChange(next, now)) return;
      this.target = { ...next, root: current.root };
    } catch {
      return;
    }
    await this.reload();
  }

  /**
   * Makes sure this head has a review file holding the branch's latest notes. A new head of
   * the same branch (commit, amend) carries over the review open until now, so the notes
   * follow the code and their anchors are found again on it. The branch's other review files
   * count too, those of heads the branch itself had (in its reflog: not those of a branch
   * deleted long ago whose name was taken again), newest first:
   * - after a rebase (or `git pull --rebase`), the review open until now is the one of the
   *   detached HEAD the rebase went through, not the branch's: the branch's own is carried;
   * - back on a head reviewed before (Undo Last Commit, a reset), its file holds only what was
   *   written then: the review of a later head of the branch (one this head is an ancestor of)
   *   holds the notes written since, and replaces it. Not one of an earlier head, even when its
   *   file was written later (a post recorded there after the review had moved on).
   */
  private async ensureReviewFile(
    store: ReviewStore,
    target: ReviewTarget,
    previous: Review | undefined,
  ): Promise<void> {
    const here = store.load(target.head.sha);
    const fresh = (): Review => ({
      version: 1,
      base: target.base,
      head: target.head,
      workTree: target.workTree,
      status: 'writing',
      annotations: [],
    });
    const detached = target.head.ref === target.head.sha.slice(0, target.head.ref.length);
    if (detached) {
      if (here.kind === 'missing') store.save(fresh());
      return;
    }
    // The heads this branch had (its reflog): what may be carried from. A branch deleted and
    // made again under its name starts a new reflog.
    const had = await branchHeads(target.root, target.head.ref);
    const ofBranch = (r: Review) =>
      r.head.ref === target.head.ref && r.head.sha !== target.head.sha && !!had?.has(r.head.sha);
    // This commit's file, unless it is a detached HEAD's (a rebase goes through its new commits
    // detached): then nothing of the branch is here yet.
    const own = here.kind === 'ok' && here.review.head.ref === target.head.ref;
    let carried: Review | undefined;
    if (!own && here.kind !== 'invalid') {
      carried =
        previous && ofBranch(previous)
          ? previous
          : await this.branchReview(store, target, had, () => Promise.resolve(true));
    } else if (own) {
      carried = await this.branchReview(store, target, had, async (later) =>
        isAncestor(target.root, target.head.sha, later),
      );
    }
    if (!carried) {
      if (here.kind === 'missing') store.save(fresh());
      return;
    }
    // Notes written on this commit while it was a detached HEAD stay, beside the branch's.
    const kept =
      here.kind === 'ok' && !own
        ? here.review.annotations.filter((a) => !carried!.annotations.some((c) => c.id === a.id))
        : [];
    store.save({
      version: 1,
      base: target.base,
      head: target.head,
      workTree: target.workTree,
      session: carried.session,
      status: carried.status,
      overview: carried.overview,
      overviewOf: carried.overviewOf,
      overviewLanguage: carried.overviewLanguage,
      annotations: [...carried.annotations, ...kept],
      github: carried.github,
      viewed: carried.viewed,
    });
    // This head holds the notes now; older heads of the branch only keep copies.
    try {
      pruneBranchReviews(store.dir, target.head.ref, store.reviewPath(target.head.sha));
    } catch {
      // A file that cannot be removed just stays.
    }
  }

  /**
   * The newest review of another head of `target`'s branch in this folder, one of the heads
   * the branch had (`had`, its reflog) that `fits`; none without a reflog to tell.
   */
  private async branchReview(
    store: ReviewStore,
    target: ReviewTarget,
    had: Set<string> | undefined,
    fits: (sha: string) => Promise<boolean>,
  ): Promise<Review | undefined> {
    if (!had) return undefined;
    let saved: SavedReview | undefined;
    try {
      saved = listSavedReviews(store.dir).find((s) => s.review.head.ref === target.head.ref);
    } catch {
      return undefined;
    }
    if (!saved) return undefined;
    const others = saved.files
      .map((file) => {
        const r = readReviewFile(file);
        let mtime = 0;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          // Gone meanwhile.
        }
        return r.kind === 'ok' ? { review: r.review, mtime } : undefined;
      })
      .filter((x): x is { review: Review; mtime: number } => !!x)
      .filter((x) => x.review.head.sha !== target.head.sha && had.has(x.review.head.sha))
      .sort((a, b) => b.mtime - a.mtime);
    for (const o of others) if (await fits(o.review.head.sha)) return o.review;
    return undefined;
  }

  /** The stored review, read fresh (tool calls must see each other's writes at once). */
  storedReview(): Review | undefined {
    const { target, store } = this;
    if (!target || !store) return undefined;
    const r = store.load(target.head.sha);
    return r.kind === 'ok' ? r.review : undefined;
  }

  /** The stored annotation, read fresh from the store (includes ones not resolved yet). */
  annotation(id: string): Annotation | undefined {
    const { target, store } = this;
    if (!target || !store) return undefined;
    const r = store.load(target.head.sha);
    return r.kind === 'ok' ? r.review.annotations.find((a) => a.id === id) : undefined;
  }

  /**
   * Marks changed files viewed (keeping the version seen, to tell a later change and diff
   * with it) or not viewed.
   */
  async setViewed(files: string[], viewed: boolean): Promise<boolean> {
    const target = this.target;
    if (!target || !files.length) return false;
    const blobs = viewed ? await rightBlobs(target, files, true) : undefined;
    if (this.target !== target) return false;
    const at = new Date().toISOString();
    return this.mutate((r) => {
      const map = { ...r.viewed };
      for (const f of files) {
        if (blobs) map[f] = { blob: blobs.get(f)!, at };
        else delete map[f];
      }
      r.viewed = Object.keys(map).length ? map : undefined;
    });
  }

  /**
   * Changes the stored review and reloads. Returns false when there is no valid review. When
   * `fn` returns UNCHANGED, it changed nothing: nothing is saved. (A mark of its own, not
   * false: a callback written `(r) => (r.flag = false)` must not skip the save, and the type
   * catches it.)
   */
  mutate(fn: (review: Review) => void | typeof UNCHANGED): boolean {
    const { target, store } = this;
    if (!target || !store) return false;
    const r = store.load(target.head.sha);
    if (r.kind !== 'ok') return false;
    if (fn(r.review) === UNCHANGED) return true;
    store.save(r.review);
    void this.reload();
    return true;
  }

  /**
   * Changes the review of a given head in a given repository (its git dir), whichever review
   * is open now: for work that started with one review and ends after the reviewer may have
   * moved to another (posting to a pull request waits on a preview and on GitHub). The open
   * one is reloaded when it is that review. Returns false when there is no such review.
   */
  mutateAt(
    at: { gitDir: string; headSha: string },
    fn: (review: Review) => void | typeof UNCHANGED,
  ): boolean {
    const { target } = this;
    if (target && target.gitDir === at.gitDir && target.head.sha === at.headSha) {
      return this.mutate(fn);
    }
    const store = new ReviewStore(at.gitDir);
    const r = store.load(at.headSha);
    const done = r.kind === 'ok' && (fn(r.review) === UNCHANGED || (store.save(r.review), true));
    // The review open now is a later head of the same branch in the same folder (a commit while
    // GitHub was answering): it carried the notes over, ids and all, so the change is its too.
    // Else the next start there would not know of it (a post recorded only at the older head
    // would go out again).
    const branch = r.kind === 'ok' ? r.review.head.ref : undefined;
    if (
      target &&
      branch &&
      target.gitDir === at.gitDir &&
      target.head.ref === branch &&
      target.head.sha !== at.headSha
    ) {
      return this.mutate(fn) || done;
    }
    return done;
  }

  async reload(): Promise<void> {
    const target = this.target;
    if (!target || !this.store) return;
    const seq = ++this.reloadSeq;
    const result = this.store.load(target.head.sha);
    if (result.kind === 'ok') {
      const [resolved, viewed] = await Promise.all([
        resolveAnnotations(target, result.review.annotations),
        viewedStates(target, result.review.viewed).catch(() => new Map<string, ViewedState>()),
      ]);
      // A later reload read the file after this one: its review is the newer (this one would
      // put back what a change since removed).
      if (this.target !== target || seq !== this.reloadSeq) return;
      this.review = result.review;
      this.resolved = resolved;
      this.viewed = viewed;
      this.loadError = undefined;
    } else {
      this.loadError = result.kind === 'invalid' ? result.error : 'The review file is missing.';
    }
    this.render();
    this.changed.fire();
  }

  private render(): void {
    this.decorator.set(this.target, this.resolved);
    this.comments.set(setting('showCommentThreads') ? this.target : undefined, this.resolved);
    this.updateStatus();
  }

  /** The branch the review is on: `feat/x`, or `detached 1a2b3c4`. */
  branchName(): string | undefined {
    const t = this.target;
    if (!t) return undefined;
    const detached = t.head.ref === t.head.sha.slice(0, 7);
    return detached ? `detached ${t.head.ref}` : t.head.ref;
  }

  /**
   * The branch the review is on, as the reviewer should see it at a glance: `branchName`,
   * with the repository's name when the window has several folders.
   */
  branchLabel(): string | undefined {
    const t = this.target;
    const branch = this.branchName();
    if (!t || !branch) return undefined;
    const several = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return several ? `${path.basename(t.root)}: ${branch}` : branch;
  }

  private updateStatus(): void {
    if (!this.target) {
      this.statusItem.hide();
      return;
    }
    const t = this.target;
    const total = this.resolved.length;
    const stale = this.resolved.filter((a) => a.state === 'stale').length;
    // The base first, as diffs show it (left ↔ right).
    const where = `${t.base.ref} ↔ ${t.head.ref} (${t.head.sha.slice(0, 7)})${t.uncommitted.length ? ` + ${t.uncommitted.length} uncommitted` : ''}`;
    if (this.loadError) {
      this.statusItem.text = '$(warning) Review Desk: review file error';
      this.statusItem.tooltip = this.loadError;
    } else {
      const notes = total
        ? ` · ${total} ${total === 1 ? 'note' : 'notes'}${stale ? `, ${stale} outdated` : ''}`
        : '';
      const me = this.review?.github?.login;
      const fresh = this.resolved.reduce((n, a) => n + newReplies(a, me).length, 0);
      const replies = fresh ? ` · $(comment-unresolved) ${fresh} new` : '';
      this.statusItem.text = `$(review-desk-logo) $(git-branch) ${this.branchLabel()}${notes}${replies}`;
      this.statusItem.tooltip = `Review Desk is reviewing ${t.root}\n${where}${total ? '' : '\nSelect code and run "Review Desk: Explain Code" to get a note.'}`;
    }
    this.statusItem.show();
  }

  /** Re-targets the review when HEAD moves; takes in fetches made elsewhere (see GitDirWatch). */
  private watchGitDir(target: ReviewTarget): void {
    this.gitDirWatch?.dispose();
    this.gitDirWatch = new GitDirWatch(target.gitDir, {
      headMaybeMoved: () => this.scheduleHeadCheck(),
      // The remote branches may have moved, and with them the base and the "newer commits" row.
      fetched: () => {
        log().info('remote branches fetched: refreshing the comparison');
        this.fetched.fire();
        void this.refreshTarget();
      },
      // Pushed: what is left to push changed (the comparison did not).
      remoteMoved: () => this.fetched.fire(),
    });
  }

  /**
   * Fetches every remote (pruning branches deleted there) for the review's repository, and
   * says what moved (see fetchAll), then refreshes the comparison once.
   */
  async fetchRemotes(): Promise<string[] | undefined> {
    const cwd = this.target?.root ?? this.workspaceCwd();
    const root = cwd && (await repoRoot(cwd).catch(() => undefined));
    if (!root) return undefined;
    const watch = this.gitDirWatch;
    const changes = await (watch ? watch.ownFetch(() => fetchAll(root)) : fetchAll(root));
    this.fetched.fire();
    await this.refreshTarget();
    return changes;
  }

  private scheduleHeadCheck(delay = 300): void {
    clearTimeout(this.headCheck);
    this.headCheck = setTimeout(() => void this.checkHead(), delay);
  }

  private async checkHead(): Promise<void> {
    const target = this.target;
    if (!target) return;
    // A start in progress (a checkout that starts its own review) may land on the new HEAD
    // or not; look again once it is done.
    if (this.starting) {
      this.scheduleHeadCheck(500);
      return;
    }
    const head = (await gitOrNull(target.root, ['rev-parse', 'HEAD']))?.trim();
    // The branch's name too: renamed (or another branch on the same commit), the review
    // takes the new name, or the next commit would not carry its notes.
    const branch =
      (await gitOrNull(target.root, ['branch', '--show-current']))?.trim() || head?.slice(0, 7);
    // Compared by root and head: a refresh in the meantime replaces the target object.
    const current = this.target;
    if (!head || !current || current.root !== target.root) return;
    if (head === current.head.sha && branch === current.head.ref) return;
    if (this.starting) {
      this.scheduleHeadCheck(500);
      return;
    }
    log().info(
      `HEAD moved ${current.head.ref} ${current.head.sha.slice(0, 7)} → ${branch} ${head.slice(0, 7)}: following it`,
    );
    const was = current.head.ref;
    const started = await this.start({
      base: current.base.ref,
      baseSource: this.baseChoice?.source,
      workTree: current.workTree,
      open: false,
    });
    // Another branch checked out (by a terminal, an agent, another tool): say so, since what
    // the review shows, and where new commits go, changed with it.
    if (started && branch !== was && setting('notifyBranchSwitch')) {
      void vscode.window.showInformationMessage(
        `Review Desk: ${path.basename(current.root)} is on ${this.branchName() ?? branch} now (was ${was}). The review follows it.`,
      );
    }
  }

  /**
   * Loads the review of the current HEAD, else the branch's latest one carried to it,
   * without opening anything.
   */
  async restore(): Promise<void> {
    // The active editor's repository first, then every workspace folder: in a multi-root
    // workspace the first folder may not be the one with a review.
    const folders = [
      this.workspaceCwd(),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    ].filter((f): f is string => !!f);
    for (const cwd of new Set(folders)) {
      try {
        const root = await repoRoot(cwd);
        const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
        const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
        const store = new ReviewStore(gitDir);
        const existing = store.load(head);
        if (existing.kind === 'ok') {
          await this.start({
            base: existing.review.base.ref,
            baseSource: 'last-review',
            workTree: existing.review.workTree,
            open: false,
            cwd,
          });
          return;
        }
        // HEAD moved while no review followed it (a commit with the window closed or the
        // move missed): continue the branch's latest review, its notes carried to this head.
        const branch = (await git(root, ['branch', '--show-current'])).trim();
        const saved = branch
          ? listSavedReviews(store.dir).find((r) => r.review.head.ref === branch)
          : undefined;
        if (saved) {
          await this.start({
            base: saved.review.base.ref,
            baseSource: 'last-review',
            workTree: saved.review.workTree,
            open: false,
            cwd,
            carry: saved.review,
          });
          return;
        }
      } catch {
        // Not a git repository or no commits yet: nothing to restore here.
      }
    }
  }

  dispose(): void {
    clearTimeout(this.headCheck);
    clearTimeout(this.workTreeCheck);
    this.gitDirWatch?.dispose();
    this.workTreeWatcher?.dispose();
    this.watcher?.dispose();
    this.decorator.dispose();
    this.comments.dispose();
    this.statusItem.dispose();
    this.folders.dispose();
    this.changed.dispose();
    this.fetched.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Whether two computations of the target show the same change: same diff, same files uncommitted. */
function sameChange(a: ReviewTarget, b: ReviewTarget): boolean {
  return diffDigest(a) === diffDigest(b) && a.uncommitted.join('\0') === b.uncommitted.join('\0');
}

/**
 * git reports the repository root with symlinks resolved (/private/var/... on macOS), while
 * editors and the git extension use the workspace folder's spelling (/var/...). URIs built
 * from the git form would not match open documents, so rewrite the root into the workspace form.
 */
export function workspaceForm(root: string): string {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const real = realpath(folder.uri.fsPath);
    if (root === real || root.startsWith(real + path.sep) || real.startsWith(root + path.sep)) {
      return path.resolve(folder.uri.fsPath, path.relative(real, root));
    }
  }
  return root;
}
