import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitDirWatch } from '../review/gitDirWatch';
import { samePath } from '../review/realpath';
import { pickRepo, readRepo, readRepos, type Repo } from '../review/repos';
import { folderIcon } from './folderKind';

const windowFolders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

/**
 * The repositories of the window's folders, and the one a review starts in: what the Review
 * list shows before a review starts (their branches; in a multi-root window, which folder).
 */
export class RepoFolders implements vscode.Disposable {
  private loading: Promise<Repo[]> | undefined;
  private repos: Repo[] = [];
  /** Picked in the list, or where the last review was: where this window's reviews go. */
  private chosen: string | undefined;
  private watches: GitDirWatch[] = [];
  /** Whether the list shows the branches now (no review open), so they are kept current. */
  private watching = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.subscriptions = [
      this.changed,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reload()),
      // Until a folder is chosen, the active editor's goes first.
      vscode.window.onDidChangeActiveTextEditor(() => {
        if (!this.chosen && this.watching) this.changed.fire();
      }),
      // A branch switched in another window: nothing watched here tells of every such move.
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && this.watching) this.reload();
      }),
    ];
  }

  /** The repositories, read once and again after a change. */
  load(): Promise<Repo[]> {
    return (this.loading ??= readRepos(windowFolders()).then((repos) => {
      this.repos = repos;
      this.rewatch();
      return repos;
    }));
  }

  /** The repositories as last read. */
  get list(): Repo[] {
    return this.repos;
  }

  /** Reads the repositories again and tells the list. */
  reload(): void {
    this.loading = undefined;
    this.changed.fire();
  }

  /**
   * Folders to start a review in, most likely first: the chosen one, the active editor's,
   * then the window's (in a multi-root window the first may be a new repository).
   */
  candidates(): string[] {
    const active = vscode.window.activeTextEditor?.document.uri;
    const editor =
      active?.scheme === 'file'
        ? vscode.workspace.getWorkspaceFolder(active)?.uri.fsPath
        : undefined;
    return [...new Set([this.chosen, editor, ...windowFolders()].filter((f): f is string => !!f))];
  }

  /** The repository a review starts in, as last read. */
  selected(): Repo | undefined {
    return pickRepo(this.repos, this.candidates());
  }

  /**
   * The folder a review starts in, read now: the first likely one with a commit, else the
   * first (a new repository or no repository, so the start says why it can't).
   */
  async startFolder(): Promise<string | undefined> {
    this.loading = undefined;
    const repos = await this.load();
    return pickRepo(repos, this.candidates())?.root ?? this.candidates()[0];
  }

  /** Makes `root` where this window's reviews go: picked in the list, or a review started. */
  choose(root: string): void {
    if (this.chosen === root) return;
    this.chosen = root;
    this.changed.fire();
  }

  /** Keeps the branches current while the list shows them (no review open). */
  setWatching(on: boolean): void {
    if (on === this.watching) return;
    this.watching = on;
    if (on) this.reload();
    else this.rewatch();
  }

  private rewatch(): void {
    for (const w of this.watches) w.dispose();
    this.watches = this.watching
      ? this.repos.map(
          (r) =>
            new GitDirWatch(
              r.gitDir,
              { headMaybeMoved: () => void this.check(r.root), fetched: () => undefined },
              3000,
            ),
        )
      : [];
  }

  /** Reads one repository again (its HEAD may have moved) and tells the list if it did. */
  private async check(root: string): Promise<void> {
    const now = await readRepo(root);
    const i = this.repos.findIndex((r) => r.root === root);
    const was = this.repos[i];
    if (i < 0 || (now && now.branch === was.branch && now.sha === was.sha)) return;
    this.reload();
  }

  dispose(): void {
    this.watching = false;
    this.rewatch();
    for (const s of this.subscriptions) s.dispose();
  }
}

/** Asks which of the window's repositories to review. */
export async function askFolder(repos: Repo[], current?: string): Promise<Repo | undefined> {
  const items = repos.map((repo) => ({
    label: path.basename(repo.root),
    iconPath: folderIcon(repo.worktree),
    description: [
      repo.branch,
      repo.worktree && 'git worktree',
      !repo.sha && 'no commits yet',
      current && samePath(current, repo.root) && 'reviewing now',
    ]
      .filter(Boolean)
      .join(' · '),
    detail: repo.root,
    repo,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Review Desk: Start Review in Folder',
    placeHolder: 'The folder (repository) to review',
  });
  return picked?.repo;
}
