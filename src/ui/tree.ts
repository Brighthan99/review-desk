import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { filePath, type DiffFile } from '../review/diffParser';
import { git } from '../review/git';
import { buildFolderTree, type FolderNode } from '../review/folderTree';
import type { HistoryRow } from '../review/history';
import { isFileNote, KIND_LABELS, type Kind, type ResolvedAnnotation } from '../review/model';
import type { Repo } from '../review/repos';
import { isLinkedWorktree } from '../review/store';
import { syncLabel, syncNote, syncOf, type Sync } from '../review/sync';
import { diffDigest, type ReviewTarget } from '../review/target';
import { triviaOf } from '../review/trivial';
import { fileNamed } from '../shared/fileNames';
import { splitSummary } from '../shared/summary';
import { setting } from '../settings';
import { ComparisonRows, DIMMED_SCHEME } from './comparisonRows';
import { branchIcon, folderKindNote } from './folderKind';
import { logRapid } from './log';

type Node =
  | { kind: 'folder'; name: string; path: string; children: Node[] }
  | {
      kind: 'file';
      path: string;
      changed?: DiffFile;
      count: number;
      /** In reading order: the part of the file the step points at. */
      range?: { start?: number; end?: number };
      inStep?: boolean;
    }
  | {
      kind: 'step';
      index: number;
      title: string;
      why?: string;
      files: Node[];
      /** The step's files, hidden ones (viewed) included. */
      paths: string[];
    }
  | { kind: 'group'; name: string; index: number; cards: ResolvedAnnotation[] }
  | { kind: 'card'; card: ResolvedAnnotation }
  /** The first row: the folder and branch under review (too long for the title's side). */
  | { kind: 'where'; sync?: Sync }
  | { kind: 'base' }
  /** After the commits before the base: opens the full list of bases to pick from. */
  | { kind: 'moreBases' }
  | { kind: 'summary' }
  | { kind: 'history'; row: HistoryRow }
  | { kind: 'info'; text: string; tooltip?: string }
  /** The review's pull request was merged or closed: finish the review from here. */
  | { kind: 'finish' }
  /** No review open: a repository of the window, its branch, and whether a review starts there. */
  | { kind: 'repo'; repo: Repo; selected: boolean; several: boolean; sync?: Sync }
  /** No review open: a way to start one (in the selected repository). */
  | { kind: 'action'; action: 'start' | 'startWithBase' | 'openPr'; repo: Repo; several: boolean };

const KIND_ICONS: Record<Kind, [string, string]> = {
  overview: ['info', 'charts.foreground'],
  why: ['lightbulb', 'charts.blue'],
  how: ['gear', 'charts.green'],
  risk: ['warning', 'charts.orange'],
  question: ['comment-discussion', 'charts.yellow'],
  context: ['references', 'charts.purple'],
  comment: ['comment', 'charts.red'],
};

const notes = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`;

const STATUS_LETTERS: Record<DiffFile['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
};

/** The Review Desk side bar list: changed files by folder, or cards in reading order. */
export class ReviewTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  /** Files by folder, notes in order, or files in the reading order the summary suggests. */
  mode: 'folder' | 'order' | 'reading' = 'folder';
  showAll = false;
  /** Leave out the changed files marked viewed (and not changed since). */
  hideViewed = false;
  /** The list's view, whose description shows the branch and counts the files viewed. */
  private listView: vscode.TreeView<unknown> | undefined;
  /** Whether a summary is being written (set from the panel). */
  summarizing: () => boolean = () => false;
  private allFiles: { head: string; files: string[] } | undefined;
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  /** The first row and the comparison rows under it. */
  private readonly comparison: ComparisonRows;

  constructor(private readonly controller: ReviewController) {
    this.comparison = new ComparisonRows(controller);
    this.subscription = vscode.Disposable.from(
      controller.onDidChange(() => this.reviewChanged()),
      // Remote branches moved: the base's "newer commits" and the comparison rows may have too.
      controller.onDidFetch(() => {
        this.comparison.forget();
        this.changed.fire(undefined);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('reviewDesk.dimTrivialChanges')) this.changed.fire(undefined);
      }),
      // No review open: the list shows the window's branches, which move on their own.
      controller.folders.onDidChange(() => {
        if (!this.controller.target) this.changed.fire(undefined);
      }),
    );
    void this.updateContext();
  }

  get view(): vscode.TreeView<unknown> | undefined {
    return this.listView;
  }

  set view(view: vscode.TreeView<unknown> | undefined) {
    this.listView = view;
    this.describeView();
  }

  /**
   * The review changed (another head or base, notes, the summary, files viewed): updates what
   * the rows depend on but do not show themselves, then draws them again. Kept out of
   * getChildren, which only reads.
   */
  private reviewChanged(): void {
    this.describeView();
    const overview = this.controller.review?.overview;
    const hasOrder = !!overview && !!splitSummary(overview).order;
    if (hasOrder !== this.hasOrder) {
      this.hasOrder = hasOrder;
      void vscode.commands.executeCommand('setContext', 'reviewDesk.hasReadingOrder', hasOrder);
    }
    // The order went away (a summary written again without one): back to folders.
    if (this.mode === 'reading' && !hasOrder) this.setMode('folder');
    else this.changed.fire(undefined);
  }

  setMode(mode: 'folder' | 'order' | 'reading'): void {
    this.mode = mode;
    void this.updateContext();
    this.changed.fire(undefined);
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  setShowAll(showAll: boolean): void {
    this.showAll = showAll;
    void this.updateContext();
    this.changed.fire(undefined);
  }

  setHideViewed(hide: boolean): void {
    this.hideViewed = hide;
    void this.updateContext();
    this.changed.fire(undefined);
  }

  /** Checkboxes ticked or cleared in the list: files marked viewed or not. */
  async checked(
    items: readonly (readonly [unknown, vscode.TreeItemCheckboxState])[],
  ): Promise<void> {
    const files = (state: vscode.TreeItemCheckboxState) =>
      items
        .filter(([n, s]) => (n as Node).kind === 'file' && s === state)
        .map(([n]) => (n as Extract<Node, { kind: 'file' }>).path);
    await this.controller.setViewed(files(vscode.TreeItemCheckboxState.Checked), true);
    await this.controller.setViewed(files(vscode.TreeItemCheckboxState.Unchecked), false);
  }

  private async updateContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'reviewDesk.treeMode', this.mode);
    await vscode.commands.executeCommand('setContext', 'reviewDesk.treeShowAll', this.showAll);
    await vscode.commands.executeCommand('setContext', 'reviewDesk.hideViewed', this.hideViewed);
  }

  /**
   * Next to the list's title: the branch the review is on, and how many changed files are
   * viewed ("feat/x · 3 of 12 viewed").
   */
  private describeView(): void {
    if (!this.listView) return;
    const total = this.controller.target?.files.length ?? 0;
    const viewed = [...this.controller.viewed.values()].filter((s) => s === 'viewed').length;
    this.listView.description = total ? `${viewed} of ${total} viewed` : undefined;
  }

  private readonly rapid = logRapid('Review');

  private dimTrivial(): boolean {
    return setting('dimTrivialChanges');
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) this.rapid();
    const target = this.controller.target;
    if (!target) return node ? [] : this.idleRows();
    if (node?.kind === 'folder') return node.children;
    if (node?.kind === 'step') return node.files;
    if (node?.kind === 'group') return node.cards.map((card) => ({ kind: 'card', card }));
    if (node?.kind === 'base') {
      // The comparison drawn as a branch; its compare and base ends change those sides.
      return [
        ...(await this.comparison.rows(target)).map((row): Node => ({ kind: 'history', row })),
        { kind: 'moreBases' },
      ];
    }
    if (node) return [];
    // The first row shows what the review compares with; clicking it picks another base.
    // The next one shows the summary of the change, writing it if needed.
    const order = this.readingSteps(target);
    const rows =
      this.mode === 'order'
        ? this.groups()
        : this.mode === 'reading' && order
          ? order
          : await this.folders();
    const summary: Node[] = target.files.length ? [{ kind: 'summary' }] : [];
    if (this.mode !== 'order' && this.hideViewed && target.files.length && !rows.length) {
      rows.push({
        kind: 'info',
        text: 'Every changed file is viewed',
        tooltip:
          'Files viewed are hidden; files changed since you viewed them come back. Show Viewed Files lists them all.',
      });
    }
    const state = this.controller.review?.github?.state;
    const finish: Node[] = state === 'merged' || state === 'closed' ? [{ kind: 'finish' }] : [];
    // Read each time the list is drawn: a fetch or push moves it (see onDidFetch).
    const where: Node = { kind: 'where', sync: await syncOf(target.root) };
    return [where, { kind: 'base' }, ...finish, ...summary, ...rows];
  }

  /**
   * No review open: the window's repositories with their branches (the one a review starts in
   * marked, when there are several), then ways to start one. None when no folder is a git
   * repository: the welcome text shows instead.
   */
  private async idleRows(): Promise<Node[]> {
    const repos = await this.controller.folders.load();
    const selected = this.controller.folders.selected();
    if (!repos.length || !selected) return [];
    const several = repos.length > 1;
    return [
      ...(await Promise.all(
        repos.map(async (repo): Promise<Node> => ({
          kind: 'repo',
          repo,
          selected: repo === selected,
          several,
          sync: await syncOf(repo.root),
        })),
      )),
      ...(['start', 'startWithBase', 'openPr'] as const).map((action): Node => ({
        kind: 'action',
        action,
        repo: selected,
        several,
      })),
    ];
  }

  /**
   * Bumped by Expand All and Collapse All. VS Code keeps each row's folded state by its id:
   * new ids for the rows that fold make them start over, all unfolded or all folded.
   */
  private expandRound = 0;
  /** Rows that fold start folded (after Collapse All) rather than unfolded. */
  private folded = false;

  private expandable(id: string): string {
    return this.expandRound ? `${id}#${this.expandRound}` : id;
  }

  /** How a row that folds starts: unfolded, or folded after Collapse All. */
  private get unfolds(): vscode.TreeItemCollapsibleState {
    return this.folded
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;
  }

  /** Unfolds every row that folds (the files' folders, steps, groups, the comparison). */
  expandAll(): void {
    this.folded = false;
    this.expandRound++;
    this.changed.fire(undefined);
  }

  /** Folds them all (the list's own: its title keeps only Compare and the menu). */
  collapseAll(): void {
    this.folded = true;
    this.expandRound++;
    this.changed.fire(undefined);
  }

  /** Whether the summary suggests a reading order (the menu offers it then). */
  get hasReadingOrder(): boolean {
    return !!this.hasOrder;
  }

  /** Shows more of the compared commits (the `… more commits` row clicked). */
  showMoreCommits(): void {
    if (this.comparison.showMore()) this.changed.fire(undefined);
  }

  /** Whether the summary suggests a reading order (the "Reading Order" button shows then). */
  private hasOrder: boolean | undefined;

  private noteCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const a of this.controller.resolved)
      if (a.file) counts.set(a.file, (counts.get(a.file) ?? 0) + 1);
    return counts;
  }

  /**
   * The changed files in the order the summary suggests reading them, a row per step; the
   * files no step names come last. Undefined when the summary has no reading order.
   */
  private readingSteps(target: ReviewTarget): Node[] | undefined {
    const overview = this.controller.review?.overview;
    const order = overview ? splitSummary(overview).order : undefined;
    if (!order) return undefined;
    const counts = this.noteCounts();
    const byPath = new Map(target.files.map((f) => [filePath(f), f]));
    const paths = [...byPath.keys()];
    const shown = (p: string) => !(this.hideViewed && this.controller.viewed.get(p) === 'viewed');
    const fileNode = (p: string, range?: { start?: number; end?: number }): Node => ({
      kind: 'file',
      path: p,
      changed: byPath.get(p),
      count: counts.get(p) ?? 0,
      range,
      inStep: true,
    });
    const seen = new Set<string>();
    const steps: Node[] = order.map((step, i) => {
      const files = step.files
        .map((f) => ({ ...f, path: fileNamed(f.file, paths) }))
        .filter((f): f is typeof f & { path: string } => !!f.path && !seen.has(f.path))
        .map((f) => (seen.add(f.path), f));
      return {
        kind: 'step',
        index: i + 1,
        title: step.title,
        why: step.why,
        paths: files.map((f) => f.path),
        files: files
          .filter((f) => shown(f.path))
          .map((f) => fileNode(f.path, f.start ? { start: f.start, end: f.end } : undefined)),
      };
    });
    const rest = paths.filter((p) => !seen.has(p)).sort();
    if (rest.length) {
      steps.push({
        kind: 'step',
        index: order.length + 1,
        title: 'Other changed files',
        why: 'Not in the suggested order: generated files, small changes, or ones it left out.',
        paths: rest,
        files: rest.filter(shown).map((p) => fileNode(p)),
      });
    }
    return steps;
  }

  private groups(): Node[] {
    const groups = new Map<string, ResolvedAnnotation[]>();
    for (const a of this.controller.resolved) {
      const name = a.group ?? 'Other';
      groups.set(name, [...(groups.get(name) ?? []), a]);
    }
    return [...groups].map(([name, cards], i) => ({ kind: 'group', name, index: i + 1, cards }));
  }

  private async folders(): Promise<Node[]> {
    const target = this.controller.target!;
    const counts = this.noteCounts();
    const byPath = new Map(target.files.map((f) => [filePath(f), f]));
    let paths = [...byPath.keys()];
    if (this.showAll) {
      // The files of HEAD, listed once per head; files new in the working tree come from the
      // diff (untracked files are in it as added), so the list follows the working tree too.
      if (this.allFiles?.head !== target.head.sha) {
        const listed = await git(target.root, ['ls-tree', '-r', '--name-only', target.head.sha]);
        this.allFiles = { head: target.head.sha, files: listed.split('\n').filter(Boolean) };
      }
      paths = [...new Set([...this.allFiles.files, ...paths])];
    }
    // Viewed files (not changed since) are left out while hidden.
    if (this.hideViewed) paths = paths.filter((p) => this.controller.viewed.get(p) !== 'viewed');
    const items = paths
      .sort()
      .map((p) => ({ path: p, changed: byPath.get(p), count: counts.get(p) ?? 0 }));
    const toNodes = (folder: FolderNode<(typeof items)[number]>): Node[] => [
      ...[...folder.folders.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f): Node => ({ kind: 'folder', name: f.name, path: f.path, children: toNodes(f) })),
      ...folder.files.map((f): Node => ({ kind: 'file', ...f })),
    ];
    return toNodes(buildFolderTree(items));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'repo') return repoItem(node);
    if (node.kind === 'action') return actionItem(node);
    const root = this.controller.target!.root;
    switch (node.kind) {
      case 'summary': {
        const { target, review } = this.controller;
        const item = new vscode.TreeItem('Summary of Changes');
        item.id = 'summary';
        const files = `${target!.files.length} ${target!.files.length === 1 ? 'file' : 'files'}`;
        const state = this.summarizing()
          ? 'writing…'
          : !review?.overview
            ? 'click to write'
            : review.overviewOf === diffDigest(target!)
              ? undefined
              : 'out of date';
        item.iconPath = new vscode.ThemeIcon(
          this.summarizing() ? 'loading~spin' : 'review-desk-logo',
        );
        item.description = [files, state].filter(Boolean).join(' · ');
        item.tooltip = review?.overview
          ? `What changed across ${files}, in the Review Desk panel.${state === 'out of date' ? '\nThe change moved on since it was written: click to see it, and Update there to write it again.' : ''}`
          : `Click to have Claude summarize what changed across ${files}.`;
        item.command = {
          command: 'reviewDesk.summarize',
          title: 'Summarize Changes',
          arguments: ['show'],
        };
        return item;
      }
      case 'base': {
        const item = this.comparison.baseItem();
        item.id = this.expandable(item.id!);
        item.collapsibleState = this.unfolds;
        return item;
      }
      case 'moreBases':
        return this.comparison.moreBasesItem();
      case 'history':
        return this.comparison.item(node.row);
      case 'where': {
        const t = this.controller.target!;
        const item = new vscode.TreeItem(this.controller.branchName() ?? t.head.ref);
        item.id = 'where';
        item.iconPath = branchIcon(isLinkedWorktree(t.gitDir), node.sync);
        item.description = [path.basename(t.root), syncLabel(node.sync)]
          .filter(Boolean)
          .join(' · ');
        const sync = syncNote(node.sync);
        item.tooltip = `${path.basename(t.root)}: ${t.head.ref} (${t.head.sha.slice(0, 7)})\n${t.root}\n${folderKindNote(t.gitDir)}${sync ? `\n${sync}` : ''}\n\nThe branch checked out in this folder: the compare side. The review follows it when it is switched or gets commits.`;
        if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
          item.tooltip += '\nClick to review another folder of this window.';
          item.command = { command: 'reviewDesk.startInFolder', title: 'Start Review in Folder…' };
        }
        return item;
      }
      case 'finish': {
        const pr = this.controller.review!.github!;
        const merged = pr.state === 'merged';
        const item = new vscode.TreeItem(
          `PR #${pr.number} ${merged ? `merged into ${pr.baseRef}` : 'closed'}`,
        );
        item.id = 'finish';
        item.iconPath = new vscode.ThemeIcon(
          merged ? 'git-merge' : 'git-pull-request-closed',
          new vscode.ThemeColor(merged ? 'charts.purple' : 'disabledForeground'),
        );
        item.description = 'finish review…';
        item.tooltip =
          'The pull request is done. Click to go back to the default branch (brought up to date with its remote) and close this review; a branch merged into it can be deleted too. The notes stay in Saved Reviews.';
        item.command = { command: 'reviewDesk.finishReview', title: 'Finish Review…' };
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.text);
        item.id = `info:${node.text}`;
        item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
        item.tooltip = node.tooltip;
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.name, this.unfolds);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.resourceUri = vscode.Uri.file(path.join(root, node.path));
        item.id = this.expandable(`folder:${node.path}`);
        return item;
      }
      case 'step': {
        const viewed = node.paths.filter((p) => this.controller.viewed.get(p) === 'viewed');
        const done = node.paths.length > 0 && viewed.length === node.paths.length;
        const item = new vscode.TreeItem(
          `${node.index}. ${node.title}`,
          node.files.length ? this.unfolds : vscode.TreeItemCollapsibleState.None,
        );
        item.id = this.expandable(`step:${node.index}`);
        item.iconPath = done
          ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
          : new vscode.ThemeIcon('circle-large-outline');
        item.description = [
          node.paths.length > 1 || viewed.length
            ? `${viewed.length}/${node.paths.length} viewed`
            : undefined,
          node.why,
        ]
          .filter(Boolean)
          .join(' · ');
        item.tooltip = `${node.title}${node.why ? `\n${node.why}` : ''}\n${viewed.length} of ${node.paths.length} files viewed\nThe order is suggested by AI with the summary: related changes together, foundations first.`;
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(path.posix.basename(node.path));
        item.resourceUri = vscode.Uri.file(path.join(root, node.path));
        item.id = `file:${node.path}`;
        const target = this.controller.target!;
        const uncommitted = target.uncommitted.includes(node.path);
        // Nothing to read line by line (generated, whitespace only, moved code): faded.
        const trivial =
          node.changed && this.dimTrivial() ? triviaOf(target).get(node.path)?.label : undefined;
        const viewed = node.changed ? this.controller.viewed.get(node.path) : undefined;
        const parts: string[] = [];
        // In reading order there are no folders: say where the file is, and the part to read.
        if (node.inStep) {
          const dir = path.posix.dirname(node.path);
          const r = node.range;
          parts.push(
            `${dir === '.' ? '' : dir}${r?.start ? `:${r.start}${r.end && r.end !== r.start ? `–${r.end}` : ''}` : ''}`,
          );
        }
        if (node.changed) parts.push(STATUS_LETTERS[node.changed.status]);
        if (viewed === 'changed') parts.push('changed since viewed');
        if (trivial) parts.push(trivial);
        if (uncommitted) parts.push('uncommitted');
        if (node.count) parts.push(notes(node.count));
        item.description = parts.filter(Boolean).join(' · ');
        if (trivial)
          item.iconPath = new vscode.ThemeIcon(
            'circle-slash',
            new vscode.ThemeColor('disabledForeground'),
          );
        item.tooltip = node.changed
          ? `${node.path}\n+${node.changed.additions} −${node.changed.deletions}${trivial ? `\n${trivial}: nothing to read line by line` : ''}${uncommitted ? '\nUncommitted changes' : ''}${node.count ? `\n${notes(node.count)}` : ''}`
          : node.path;
        item.command = {
          command: 'reviewDesk.openFile',
          title: 'Open',
          arguments: node.range?.start ? [node.path, node.range.start] : [node.path],
        };
        item.contextValue = node.changed
          ? viewed === 'changed'
            ? 'changedFileSinceViewed'
            : 'changedFile'
          : 'file';
        if (node.changed) {
          // Like GitHub's Viewed box: ticked until the file changes again.
          item.checkboxState = {
            state:
              viewed === 'viewed'
                ? vscode.TreeItemCheckboxState.Checked
                : vscode.TreeItemCheckboxState.Unchecked,
            tooltip:
              viewed === 'viewed'
                ? 'Viewed. Clear to mark it not viewed.'
                : viewed === 'changed'
                  ? 'Changed since you viewed it: Diff Since Viewed shows what changed. Tick when viewed again.'
                  : 'Tick when viewed. It clears itself if the file changes again.',
          };
          if (viewed === 'changed')
            item.tooltip += '\nChanged since you marked it viewed: Diff Since Viewed shows how.';
        }
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(`${node.index}. ${node.name}`, this.unfolds);
        item.id = this.expandable(`group:${node.name}`);
        item.description = notes(node.cards.length);
        return item;
      }
      case 'card': {
        const a = node.card;
        const item = new vscode.TreeItem(`${a.number}. ${a.title}`);
        item.id = `card:${a.id}`;
        const [icon, color] = KIND_ICONS[a.kind];
        item.iconPath = new vscode.ThemeIcon(
          a.understood ? 'pass-filled' : icon,
          new vscode.ThemeColor(color),
        );
        item.description = !a.file
          ? 'Whole change'
          : isFileNote(a)
            ? `${path.basename(a.file)} · file`
            : `${path.basename(a.file)}:${a.resolvedStart}`;
        item.tooltip = `${KIND_LABELS[a.kind]}${a.state === 'stale' ? ' · outdated' : ''}\n${a.title}`;
        item.command = { command: 'reviewDesk.selectCard', title: 'Select', arguments: [a.id] };
        return item;
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

/** A repository of the window, before a review starts: its branch (and, among several, a pick). */
function repoItem(node: Extract<Node, { kind: 'repo' }>): vscode.TreeItem {
  const { repo, selected, several, sync } = node;
  const name = path.basename(repo.root);
  const empty = !repo.sha;
  // One repository: its branch first, as the review's first row has it. Several: the folders.
  const item = new vscode.TreeItem(several ? name : repo.branch);
  item.id = `repo:${repo.root}`;
  item.description = [
    several ? repo.branch : name,
    several && repo.worktree && 'git worktree',
    empty && 'no commits yet',
    syncLabel(sync),
  ]
    .filter(Boolean)
    .join(' · ');
  // Several: a choice, shown as picked or not; the worktree among them says so beside it.
  item.iconPath = !several
    ? branchIcon(repo.worktree, sync)
    : new vscode.ThemeIcon(
        selected ? 'pass-filled' : 'circle-large-outline',
        selected ? new vscode.ThemeColor('charts.blue') : undefined,
      );
  const where = `${name}: ${repo.branch}${repo.sha ? ` (${repo.sha.slice(0, 7)})` : ''}\n${repo.root}\n${folderKindNote(repo.gitDir)}${syncNote(sync) ? `\n${syncNote(sync)}` : ''}`;
  const what = empty
    ? 'A new repository: nothing to review until its first commit.'
    : !several
      ? 'The branch checked out here. Start Review compares it with its base (the pull request target, or main).'
      : selected
        ? 'Start Review reviews this folder.'
        : 'Click to review this folder instead.';
  item.tooltip = `${where}\n\n${what}`;
  if (empty) item.resourceUri = vscode.Uri.from({ scheme: DIMMED_SCHEME, path: `/${name}` });
  item.contextValue = empty ? 'repoEmpty' : 'repo';
  if (several && !selected) {
    item.command = {
      command: 'reviewDesk.chooseFolder',
      title: 'Review This Folder',
      arguments: [repo.root],
    };
  }
  return item;
}

const ACTIONS = {
  start: {
    label: 'Start Review',
    icon: 'play',
    command: 'reviewDesk.start',
    tooltip:
      'Compares the branch with its base (the pull request target, or main) and opens the changes.',
  },
  startWithBase: {
    label: 'Start Review Against Branch…',
    icon: 'git-compare',
    command: 'reviewDesk.startWithBase',
    tooltip: 'Picks the branch, tag or commit to compare with first.',
  },
  openPr: {
    label: 'Open GitHub Pull Request…',
    icon: 'github',
    command: 'reviewDesk.github.open',
    tooltip: 'Picks an open pull request, checks it out here or in a new worktree, and reviews it.',
  },
};

/** A way to start a review, before one is open; among several repositories, in the selected one. */
function actionItem(node: Extract<Node, { kind: 'action' }>): vscode.TreeItem {
  const a = ACTIONS[node.action];
  const item = new vscode.TreeItem(a.label);
  item.id = `action:${node.action}`;
  item.iconPath = new vscode.ThemeIcon(a.icon);
  const name = path.basename(node.repo.root);
  if (node.several) item.description = `in ${name}`;
  item.tooltip = a.tooltip;
  item.command = {
    command: a.command,
    title: a.label,
    arguments: node.action === 'start' ? [{ cwd: node.repo.root }] : [],
  };
  return item;
}
