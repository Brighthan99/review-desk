import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import type { BaseChoice } from '../review/branchBase';
import { comparisonHistory, type HistoryRow } from '../review/history';
import type { ReviewTarget } from '../review/target';

/** Compared commits shown at first, and how many more each `… more commits` click adds. */
const FIRST_COMMITS = 15;
const MORE_COMMITS = 50;

/** Rows of the list shown faded: commits before the base, not part of the comparison. */
export const DIMMED_SCHEME = 'review-desk-dimmed';

/**
 * Fades the label of the rows marked with DIMMED_SCHEME: a tree row's label takes the color
 * of its resource's decoration, the only way to color one.
 */
export class DimmedRows implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === DIMMED_SCHEME
      ? new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor('disabledForeground'))
      : undefined;
  }
}

/**
 * A row label marked as the base or the compare side of the comparison, as GitHub's compare
 * page names them (`base: main`, `compare: feat/login`), the mark emphasized.
 */
function sideLabel(side: Side | undefined, text: string): vscode.TreeItemLabel {
  return side ? { label: `${side}: ${text}`, highlights: [[0, side.length + 1]] } : { label: text };
}

/** The two sides of a comparison: the base (the diff's left) and the compare side (its right). */
type Side = 'base' | 'compare';

/** Where the base came from: a short tag for the row (PR targets only) and a full line. */
function baseSourceLabel(choice: BaseChoice | undefined): { short?: string; long: string } {
  switch (choice?.source) {
    case 'pr':
      return {
        short: `PR ${choice.detail} target`,
        long: `target of the open PR ${choice.detail}`,
      };
    case 'gh-merge-base':
      return { short: 'PR target', long: `PR target on record (git config gh-merge-base)` };
    case 'last-review':
      return { long: 'the base this branch was last reviewed against' };
    case 'setting':
      return { long: 'the reviewDesk.baseRef setting' };
    case 'picked':
      return { long: 'picked' };
    default:
      return { long: 'the default branch' };
  }
}

/**
 * The rows of the Review list about the comparison: the first row (what it compares with),
 * and under it the comparison drawn as a branch, the compare side on top, the commits
 * between, the base, then a few commits before the base, faded.
 */
export class ComparisonRows {
  private cache: { key: string; at: number; rows: HistoryRow[] } | undefined;
  /** How many compared commits the rows show, for one base (`… more commits` adds some). */
  private shown = { side: '', count: FIRST_COMMITS };

  private commitsShown(target: ReviewTarget): number {
    return this.shown.side === `${target.root}\n${target.base.sha}`
      ? this.shown.count
      : FIRST_COMMITS;
  }

  /** Shows more of the compared commits (the `… more commits` row clicked): false if none. */
  showMore(): boolean {
    const t = this.controller.target;
    if (!t) return false;
    this.shown = {
      side: `${t.root}\n${t.base.sha}`,
      count: this.commitsShown(t) + MORE_COMMITS,
    };
    return true;
  }

  /**
   * The comparison rows, computed again only when HEAD, the base, the uncommitted files or
   * the number of commits shown change, or after a minute (a base branch may move on after a
   * fetch).
   */
  async rows(target: ReviewTarget): Promise<HistoryRow[]> {
    const shown = this.commitsShown(target);
    const key = [target.root, target.head.sha, target.base.sha, target.base.ref, String(shown)]
      .concat(target.uncommitted)
      .join('\n');
    const cached = this.cache;
    if (cached?.key === key && Date.now() - cached.at < 60_000) return cached.rows;
    const rows = await comparisonHistory(target, shown);
    this.cache = { key, at: Date.now(), rows };
    return rows;
  }

  constructor(private readonly controller: ReviewController) {}

  /** Forgets the rows computed (remote branches moved: a base branch may have too). */
  forget(): void {
    this.cache = undefined;
  }

  /** The first row: what the review compares; it expands into the rows of the comparison. */
  baseItem(): vscode.TreeItem {
    const t = this.controller.target!;
    // Expands into the comparison drawn as a branch (see `history` rows).
    // The base first, as diffs show it (left ↔ right).
    const item = new vscode.TreeItem(
      `${t.base.ref} ↔ ${t.head.ref}`,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = 'base';
    item.iconPath = new vscode.ThemeIcon('git-compare');
    const source = baseSourceLabel(this.controller.baseChoice);
    // A merged or closed PR has a row of its own below (finish the review).
    item.description = [t.uncommitted.length ? '+ uncommitted' : undefined, source.short, 'change…']
      .filter(Boolean)
      .join(' · ');
    item.tooltip = `base: ${t.base.ref} (${t.base.sha.slice(0, 7)}) ↔ compare: ${t.head.ref}${t.uncommitted.length ? ' + uncommitted' : ''}\nBase: ${source.long}\nClick to change the base or the compare side, or paste a pull request's address to review it.`;
    item.command = { command: 'reviewDesk.compare', title: 'Compare…' };
    return item;
  }

  /** After the commits before the base: opens the full list of bases to pick from. */
  moreBasesItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Older commits, branches, tags…');
    item.id = 'history:moreBases';
    item.iconPath = new vscode.ThemeIcon('list-selection');
    item.tooltip = 'Pick the base from recent commits, branches or tags, or type any git ref.';
    item.command = { command: 'reviewDesk.changeBase', title: 'Change Base…' };
    return item;
  }

  /**
   * A row of the comparison drawn as a branch: the compare side on top, the base below.
   */
  item(row: HistoryRow): vscode.TreeItem {
    const t = this.controller.target!;
    switch (row.kind) {
      case 'uncommitted': {
        const item = new vscode.TreeItem(sideLabel('compare', 'Uncommitted changes'));
        item.id = 'history:uncommitted';
        item.iconPath = new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.green'));
        item.description = `${row.files} ${row.files === 1 ? 'file' : 'files'}${row.added ? ` · ${row.added} new` : ''} · change…`;
        item.tooltip =
          'Compare side of the comparison: the files on disk, including these uncommitted changes.\nClick to review HEAD only, or another branch or commit.';
        item.command = { command: 'reviewDesk.changeRight', title: 'Change Compare Side…' };
        return item;
      }
      case 'commit':
      case 'base': {
        const isBase = row.kind === 'base';
        // Without uncommitted changes on top, HEAD itself is the compare side.
        const compareSide = !isBase && row.refs.includes('HEAD') && !t.uncommitted.length;
        const side: Side | undefined = isBase ? 'base' : compareSide ? 'compare' : undefined;
        const item = new vscode.TreeItem(sideLabel(side, `${row.short} ${row.subject}`));
        item.id = `history:${row.kind}:${row.sha}`;
        item.iconPath = new vscode.ThemeIcon(
          'git-commit',
          isBase ? new vscode.ThemeColor('charts.orange') : undefined,
        );
        item.description = [
          ...row.refs,
          compareSide && !t.workTree ? 'HEAD only' : undefined,
          side ? 'change…' : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
        const where = isBase
          ? `\n\nBase of the comparison: where ${t.head.ref} left ${t.base.ref}.\nClick to compare against another commit, branch or tag; it need not be checked out.`
          : compareSide
            ? `\n\nCompare side of the comparison${t.workTree ? '' : ' (HEAD only, uncommitted edits left out)'}.\nClick to review the working tree, or another branch or commit.`
            : '\n\nClick to make it the base or the compare side.';
        item.tooltip = `${row.sha}\n${row.subject}${where}`;
        item.command = isBase
          ? { command: 'reviewDesk.changeBase', title: 'Change Base…' }
          : compareSide
            ? { command: 'reviewDesk.changeRight', title: 'Change Compare Side…' }
            : {
                command: 'reviewDesk.commitActions',
                title: 'Use This Commit…',
                arguments: [{ row }],
              };
        // HEAD as the compare side already: it can still become the base.
        item.contextValue = isBase ? 'historyBase' : compareSide ? 'historyHead' : 'historyCommit';
        return item;
      }
      case 'earlier': {
        const item = new vscode.TreeItem(`${row.short} ${row.subject}`);
        item.id = `history:earlier:${row.sha}`;
        // Not part of the comparison: the whole row faded, its label too (see DimmedRows).
        item.resourceUri = vscode.Uri.from({ scheme: DIMMED_SCHEME, path: `/${row.sha}` });
        item.iconPath = new vscode.ThemeIcon(
          'circle-outline',
          new vscode.ThemeColor('disabledForeground'),
        );
        item.description = [...row.refs, 'earlier · not compared'].join(' · ');
        item.tooltip = `${row.sha}\n${row.subject}\n\nBefore the base: not part of this comparison.\nClick to move the base back to it.`;
        item.command = {
          command: 'reviewDesk.commitActions',
          title: 'Use This Commit…',
          arguments: [{ row }],
        };
        item.contextValue = 'historyEarlier';
        return item;
      }
      case 'more': {
        const item = new vscode.TreeItem(
          `… ${row.count} more ${row.count === 1 ? 'commit' : 'commits'}`,
        );
        item.id = 'history:more';
        item.iconPath = new vscode.ThemeIcon('unfold');
        const next = Math.min(row.count, MORE_COMMITS);
        item.description = row.count > next ? `show ${next} more` : 'show';
        item.tooltip = `Click to show ${row.count > next ? `the next ${next}` : row.count === 1 ? 'it' : 'them'}.`;
        item.command = { command: 'reviewDesk.tree.moreCommits', title: 'Show More Commits' };
        return item;
      }
      case 'ahead': {
        const item = new vscode.TreeItem(
          `${row.ref} has ${row.count} newer ${row.count === 1 ? 'commit' : 'commits'}`,
        );
        item.id = 'history:ahead';
        item.iconPath = new vscode.ThemeIcon('info');
        item.description = 'not included';
        item.tooltip = `The comparison starts where ${t.head.ref} left ${row.ref}; commits added to ${row.ref} since are not part of this review.`;
        return item;
      }
    }
  }
}
