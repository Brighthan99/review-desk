import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { gitOrNull } from '../review/git';
import { realpath, samePath } from '../review/realpath';
import { listSavedReviews } from '../review/savedReviews';
import { storeDir } from '../review/store';
import { repoRoot } from '../review/target';
import {
  listWorktrees,
  madeFor,
  removalProblem,
  removeWorktree,
  type MadeFor,
  type WorktreeInfo,
} from '../review/worktree';
import { syncLabel, syncNote, syncOf, type Sync } from '../review/sync';
import { folderIcon } from './folderKind';
import { addToWindow, openWindow } from './place';
import { log } from './log';
import type { Prompts } from './prompts';
import {
  closeWorktreeEditors,
  ignoredNote,
  leaveWindow,
  unpushedNote,
  windowNote,
} from './worktreeRemoval';

/** A worktree with what Review Desk knows of it. */
export interface WorktreeRow {
  /** The repository's main folder, where git commands about its worktrees run. */
  repo: string;
  info: WorktreeInfo;
  /** Open in this window (one of its folders). */
  here: boolean;
  /** Reviews kept for it, and their notes (the latest review of each branch). */
  reviews: number;
  notes: number;
  reviewed?: { branch: string; updated: number };
  made?: MadeFor;
  /** The repository has other worktrees than this one. */
  others: boolean;
  /** Its branch against the remote: what is left to push or pull. */
  sync?: Sync;
}

type Loaded = { repo: string; rows: WorktreeRow[] }[];

/** What the list shows of `loaded`, to tell whether a refresh changed anything. */
const rowsKey = (loaded: Loaded) => JSON.stringify(loaded);

type Node =
  { kind: 'repo'; repo: string; rows: WorktreeRow[] } | { kind: 'worktree'; row: WorktreeRow };

function watch(
  dir: string,
  on: (filename: string | null) => void,
  recursive = false,
): fs.FSWatcher | undefined {
  try {
    const watcher = fs.watch(dir, { recursive }, (_event, filename) => on(filename));
    watcher.on('error', () => watcher.close());
    return watcher;
  } catch {
    return undefined; // Not there (yet).
  }
}

/**
 * Tells when worktrees of a repository are added, removed or pruned, from anywhere (a terminal,
 * another window): each has an entry in `<git common dir>/worktrees`, a folder git makes with
 * the first one and removes with the last. And when its branches move (a commit, a fetch, a
 * push: `<git common dir>/refs`, packed-refs), which changes what is left to push or pull.
 */
class WorktreeEntries implements vscode.Disposable {
  private readonly top: fs.FSWatcher | undefined;
  private readonly refs: fs.FSWatcher | undefined;
  private dir: fs.FSWatcher | undefined;
  private seen: string;

  constructor(
    private readonly commonDir: string,
    private readonly changed: (why: string) => void,
  ) {
    this.seen = this.entries();
    this.top = watch(commonDir, (f) => {
      if (f === 'packed-refs') return this.changed('branches moved');
      if (f !== null && f !== 'worktrees') return; // HEAD, index… change all the time.
      this.watchEntries(); // Made or removed: watch the new one.
      this.check();
    });
    this.refs = watch(path.join(commonDir, 'refs'), () => this.changed('branches moved'), true);
    this.watchEntries();
  }

  private get entriesDir(): string {
    return path.join(this.commonDir, 'worktrees');
  }

  private entries(): string {
    try {
      return fs.readdirSync(this.entriesDir).sort().join('\n');
    } catch {
      return '';
    }
  }

  private watchEntries(): void {
    this.dir?.close();
    this.dir = watch(this.entriesDir, () => this.check());
  }

  /** Events also come for files inside the entries: only a changed set of entries counts. */
  private check(): void {
    const now = this.entries();
    if (now === this.seen) return;
    this.seen = now;
    this.changed('worktrees added or removed');
  }

  dispose(): void {
    this.top?.close();
    this.refs?.close();
    this.dir?.close();
  }
}

const quote = (p: string) => `"${p.replace(/(["\\$`])/g, '\\$1')}"`;

/** The command that removes a worktree (or prunes a missing one), to run in a terminal. */
export function removeCommand(row: WorktreeRow): string {
  return row.info.prunable
    ? `git -C ${quote(row.repo)} worktree prune`
    : `git -C ${quote(row.repo)} worktree remove ${quote(row.info.path)}`;
}

/**
 * The git worktrees of the workspace's repositories: which one this window has, which were
 * used for a review (and how many notes they hold), which Review Desk made, with buttons to
 * open one in a new window, remove it, or copy the command that removes it.
 */
export class WorktreesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private shown = '';
  /** By git common dir: every workspace repository, also those with no other worktree yet. */
  private readonly watched = new Map<string, WorktreeEntries>();
  private soon: NodeJS.Timeout | undefined;
  /** Rows `refresh` read, for the list to take when it asks for them right after. */
  private next: Loaded | undefined;
  /** The rows the list shows, as a key: a refresh that reads the same redraws nothing. */
  private shownRows = '';
  private reloading: Promise<void> | undefined;
  private again = false;

  constructor(
    private readonly controller: ReviewController,
    private readonly prompts: Prompts,
  ) {
    this.subscriptions = [
      // A review moving to another branch or repository may have made or used a worktree,
      // and a note more or less changes this one's count.
      controller.onDidChange(() => {
        const t = controller.target;
        const key = t ? `${t.root}\n${t.head.ref}\n${controller.review?.annotations.length}` : '';
        if (key === this.shown) return;
        this.shown = key;
        this.refresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      this.changed,
    ];
  }

  /**
   * Reads the worktrees again, and redraws the list only when what it shows changed. A redraw
   * makes VS Code forget the list's rows until it has asked for them again; a button clicked
   * meanwhile reaches its command with no row. So the rows are read first (git is slow at
   * times) and handed over as soon as the list asks, and a refresh that changes nothing shown
   * (the window focused again, a fetch that moved no branch of a worktree) redraws nothing.
   * Asked again while reading, it reads once more before redrawing.
   */
  refresh(): Promise<void> {
    // What was read before may be out of date now.
    this.next = undefined;
    if (this.reloading) {
      this.again = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      let loaded: Loaded | undefined;
      do {
        this.again = false;
        loaded = await this.load().catch((e: unknown) => {
          log().info(`could not read the worktrees: ${e instanceof Error ? e.message : e}`);
          return undefined;
        });
      } while (this.again);
      if (!loaded || rowsKey(loaded) === this.shownRows) return;
      this.next = loaded;
      this.changed.fire(undefined);
    })().finally(() => (this.reloading = undefined));
    return this.reloading;
  }

  /** The rows of every workspace repository, like `git worktree list`: its own folder first. */
  async load(): Promise<Loaded> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const here = new Set(folders.map(realpath));
    const repos = new Map<string, WorktreeRow[]>();
    const common = new Set<string>();
    for (const folder of folders) {
      const root = await repoRoot(folder).catch(() => undefined);
      if (!root) continue;
      const dir = (
        await gitOrNull(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      )?.trim();
      if (dir) common.add(dir);
      const list = await listWorktrees(root).catch(() => []);
      const main = list.find((w) => w.main)?.path;
      if (!main || repos.has(main)) continue;
      const others = list.length > 1;
      repos.set(main, await Promise.all(list.map((info) => this.row(main, info, here, others))));
    }
    this.watch(common);
    return [...repos].map(([repo, rows]) => ({ repo, rows }));
  }

  private watch(commonDirs: Set<string>): void {
    for (const [dir, entries] of this.watched) {
      if (commonDirs.has(dir)) continue;
      entries.dispose();
      this.watched.delete(dir);
    }
    for (const dir of commonDirs) {
      if (this.watched.has(dir)) continue;
      this.watched.set(
        dir,
        new WorktreeEntries(dir, (why) => {
          clearTimeout(this.soon);
          this.soon = setTimeout(() => {
            log().info(`${why} (${dir}): refreshing the Worktrees list`);
            this.refresh();
          }, 300);
        }),
      );
    }
  }

  private async row(
    repo: string,
    info: WorktreeInfo,
    here: Set<string>,
    others: boolean,
  ): Promise<WorktreeRow> {
    const row: WorktreeRow = {
      repo,
      info,
      here: here.has(realpath(info.path)),
      reviews: 0,
      notes: 0,
      others,
    };
    if (info.prunable || !fs.existsSync(info.path)) return row;
    row.sync = await syncOf(info.path);
    const gitDir = (await gitOrNull(info.path, ['rev-parse', '--absolute-git-dir']))?.trim();
    if (!gitDir) return row;
    // All worktrees keep their reviews together: this one's are those of what it has out.
    const saved = listSavedReviews(storeDir(gitDir)).filter((s) =>
      info.branch
        ? s.review.head.ref === info.branch
        : !!info.head && s.review.head.sha === info.head,
    );
    row.reviews = saved.reduce((n, s) => n + s.files.length, 0);
    row.notes = saved.reduce((n, s) => n + s.review.annotations.length, 0);
    if (saved[0]) row.reviewed = { branch: saved[0].review.head.ref, updated: saved[0].updated };
    row.made = madeFor(gitDir);
    return row;
  }

  /**
   * Reviews a worktree in this window: added to its folders first when it is not one of them
   * (its review starts once it is in), else straight away. The base is chosen as for any
   * review: the pull request target, the last one used, else main. Its review open already:
   * nothing to do.
   */
  async review(row: WorktreeRow): Promise<void> {
    const t = this.controller.target;
    if (t && samePath(t.root, row.info.path)) return;
    await addToWindow(row.info.path, {}, this.prompts);
  }

  /** Opens a worktree in a new window, where its review starts (as `review` chooses its base). */
  async open(row: WorktreeRow): Promise<void> {
    await openWindow(row.info.path, {}, this.prompts);
  }

  /**
   * Removes a worktree after asking, or tells why it cannot be: the folder open in this
   * window, the main folder, a locked one, uncommitted work, commits only it has. Its
   * branch, commits and Review Desk notes stay.
   */
  async remove(shown: WorktreeRow): Promise<boolean> {
    const name = path.basename(shown.info.path);
    const cannot = (why: string) => {
      this.prompts.warn(`Review Desk: cannot remove the worktree ${name}: ${why}`);
      return false;
    };
    // As it is now, not as the list last showed it: a switch to a detached HEAD (and commits
    // made there) since then must count.
    const now = (await listWorktrees(shown.repo).catch(() => undefined))?.find((w) =>
      samePath(w.path, shown.info.path),
    );
    const row: WorktreeRow = now ? { ...shown, info: now } : shown;
    const problem = await removalProblem(row.repo, row.info).catch((e: unknown) =>
      e instanceof Error ? e.message : String(e),
    );
    if (problem) return cannot(problem);
    const gone = row.info.prunable || !fs.existsSync(row.info.path);
    const keeps = row.info.branch
      ? `The branch ${row.info.branch} and its commits stay`
      : 'Its commits stay';
    const ignored = gone ? '' : await ignoredNote(row.info.path);
    const unpushed = await unpushedNote(row.repo, row.info.branch);
    const message = gone
      ? `Forget the worktree ${name}? Its folder is already gone; this clears git's record of it.`
      : `Remove the worktree ${name}? Its folder ${row.info.path} is deleted, ignored files (such as node_modules) too.${ignored} ${keeps}, and so do its Review Desk notes.${unpushed}${row.here ? windowNote(row.info.path) : ' Close any other window that has it open first.'}`;
    if (!(await this.prompts.confirm(message, gone ? 'Forget' : 'Remove'))) return false;
    // One of this window's folders: its review and editors close first, and it leaves the
    // window last (or the window closes, when it was the only folder).
    if (row.here && !(await closeWorktreeEditors(this.controller, row.info.path))) return false;
    try {
      await removeWorktree(row.repo, row.info);
    } catch (e) {
      return cannot(e instanceof Error ? e.message : String(e));
    }
    this.refresh();
    if (row.here) await leaveWindow(this.prompts, row.info.path);
    return true;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node?.kind === 'repo') return node.rows.map((row) => ({ kind: 'worktree', row }));
    if (node) return [];
    // Asked while reading again (a change meanwhile): the rows that reading gives.
    if (this.reloading) await this.reloading;
    const repos = this.next ?? (await this.load());
    this.next = undefined;
    this.shownRows = rowsKey(repos);
    // One repository: its worktrees directly. Several: a folder per repository.
    if (repos.length === 1) return this.getChildren({ kind: 'repo', ...repos[0] });
    return repos.map((r) => ({ kind: 'repo', ...r }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(
        path.basename(node.repo),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `worktrees:${node.repo}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      return item;
    }
    const { row } = node;
    const { info } = row;
    const item = new vscode.TreeItem(path.basename(info.path));
    item.id = `worktree:${info.path}`;
    // The repository's own folder, or a worktree made from it (how reviewed: beside it).
    item.iconPath = info.prunable
      ? new vscode.ThemeIcon('warning')
      : folderIcon(!info.main, row.sync);
    const where = info.branch ?? (info.head ? `detached ${info.head.slice(0, 7)}` : '');
    item.description = [
      where,
      syncLabel(row.sync) || undefined,
      info.main ? 'main folder' : undefined,
      row.here ? 'this window' : undefined,
      row.reviews ? `reviewed · ${row.notes} ${row.notes === 1 ? 'note' : 'notes'}` : undefined,
      row.made ? 'made by Review Desk' : undefined,
      info.prunable ? 'folder missing' : undefined,
      info.locked ? 'locked' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    const lines = [
      info.path,
      // The icon may be an arrow (commits to push or pull): the kind of folder in words too.
      info.main ? "The repository's own folder." : `A git worktree of ${path.basename(row.repo)}.`,
      `${where}${info.head ? ` (${info.head.slice(0, 12)})` : ''}`,
    ];
    const sync = syncNote(row.sync);
    if (sync) lines.push(sync);
    if (row.reviewed) {
      lines.push(
        `Reviewed: ${row.reviews} review ${row.reviews === 1 ? 'file' : 'files'}, ${row.notes} notes; latest on ${row.reviewed.branch}, ${new Date(row.reviewed.updated).toLocaleString()}.`,
      );
    } else lines.push('Not used for a review.');
    if (row.made) {
      lines.push(
        `Made by Review Desk for ${row.made.purpose === 'pr' ? 'a pull request' : 'the compare side of a comparison'} (${row.made.ref}), ${new Date(row.made.at).toLocaleString()}.`,
      );
    }
    if (!info.main) lines.push(`Remove: ${removeCommand(row)}`);
    else if (!row.others) {
      lines.push(
        'No other worktrees yet: picking another branch or commit as the compare side of a comparison can check it out in one, for a new window.',
      );
    }
    if (!info.prunable) {
      lines.push(
        row.here
          ? 'Click to review it.'
          : 'Click to review it in this window (added to its folders first).',
      );
      item.command = {
        command: 'reviewDesk.reviewWorktree',
        title: 'Review in This Window',
        arguments: [node],
      };
    }
    item.tooltip = lines.join('\n');
    item.contextValue = info.prunable
      ? 'worktreePrunable'
      : `worktree${info.main ? 'Main' : ''}${row.here ? 'Here' : ''}`;
    return item;
  }

  dispose(): void {
    clearTimeout(this.soon);
    for (const entries of this.watched.values()) entries.dispose();
    for (const d of this.subscriptions) d.dispose();
  }
}
