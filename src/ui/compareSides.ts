import * as vscode from 'vscode';
import type { ReviewController, StartOptions } from '../controller';
import { parsePullUrl } from '../github/prUrl';
import { gitOrNull } from '../review/git';
import { branchCommit, branchRefs, commitLabel, recentCommits } from '../review/refList';
import { repoRoot, type ReviewTarget } from '../review/target';
import { checkOut, type Place } from './place';
import type { Prompts } from './prompts';
import { errorText, showError, showWarning } from './log';

/**
 * What the compare side of the comparison can be: the files on disk (uncommitted edits
 * included), HEAD alone, or another branch or commit, checked out in a worktree of its own
 * (reviewed in a new window) or here.
 */
export type RightSide =
  { kind: 'workTree' } | { kind: 'head' } | { kind: 'ref'; ref: string; mode: Place };

type Start = (options: StartOptions) => Promise<boolean>;

const RIGHT_KINDS = {
  workTree: 'working tree, uncommitted edits included',
  head: 'HEAD only, committed changes',
};

/**
 * What the comparison row (or Compare…) leads to: a side to change, or a pull request to
 * review instead, pasted in (its base on the left, its head on the right) or asked for.
 */
export type SidePick = 'base' | 'compare' | 'pull' | { pullUrl: string };

/**
 * Asks which side to change, from the two sides as they are now; a pull request's address
 * pasted in reviews that pull request instead.
 */
export async function askSide(t: ReviewTarget | undefined): Promise<SidePick | undefined> {
  if (!t) return 'base';
  type Item = vscode.QuickPickItem & { pick: SidePick };
  const sides: Item[] = [
    {
      label: `$(arrow-left) base: ${t.base.ref}`,
      description: `merge base ${t.base.sha.slice(0, 7)}`,
      detail: 'Compare against another branch, tag or commit (it need not be checked out).',
      pick: 'base',
    },
    {
      label: `$(arrow-right) compare: ${t.head.ref}`,
      description: t.workTree ? RIGHT_KINDS.workTree : RIGHT_KINDS.head,
      detail: 'Review the working tree, HEAD only, or another branch or commit.',
      pick: 'compare',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator, pick: 'base' },
    {
      label: '$(github) Pull Request…',
      detail:
        'An open one, or any by its address (or paste it here). Its base as the base, its head as the compare side.',
      pick: 'pull',
    },
  ];
  const qp = vscode.window.createQuickPick<Item>();
  qp.items = sides;
  qp.title = `${t.base.ref} ↔ ${t.head.ref}`;
  qp.placeholder =
    'Change the base or the compare side? Or paste a pull request address (https://github.com/…/pull/12)';
  // A pull request's address typed or pasted: an item to review it, above the sides.
  qp.onDidChangeValue((value) => {
    const pr = parsePullUrl(value);
    qp.items = pr
      ? [
          {
            label: `$(git-pull-request) Review Pull Request #${pr.number}`,
            description: `${pr.owner}/${pr.repo}`,
            detail: 'Its base as the base, its head as the compare side.',
            alwaysShow: true,
            pick: { pullUrl: value.trim() },
          },
          ...sides,
        ]
      : sides;
  });
  return new Promise<SidePick | undefined>((resolve) => {
    qp.onDidAccept(() => {
      const value = qp.value.trim();
      resolve(qp.selectedItems[0]?.pick ?? (parsePullUrl(value) ? { pullUrl: value } : undefined));
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

/** Lets the reviewer pick the compare side; another branch or commit also asks where to check it out. */
export async function pickRight(
  controller: ReviewController,
  prompts: Prompts,
): Promise<RightSide | undefined> {
  const t = controller.target;
  const cwd = t?.root ?? controller.workspaceCwd();
  if (!cwd) return undefined;
  const root = await repoRoot(cwd).catch(() => undefined);
  if (!root) return undefined;
  const head = (await gitOrNull(root, ['branch', '--show-current']))?.trim() || 'HEAD';
  const [branches, commits] = await Promise.all([branchRefs(root), recentCommits(root)]);
  // `side` and not `kind`: a quick pick item's `kind` marks separators.
  type Item = vscode.QuickPickItem & { side?: 'workTree' | 'head'; ref?: string };
  const section = (label: string, items: Item[]): Item[] =>
    items.length ? [{ label, kind: vscode.QuickPickItemKind.Separator }, ...items] : [];
  const current = (on: boolean) => (on ? ' · current' : '');
  const items: Item[] = [
    {
      label: '$(edit) Working Tree',
      description: `${head} · uncommitted edits included${current(!!t && t.workTree)}`,
      side: 'workTree',
    },
    {
      label: '$(git-commit) HEAD',
      description: `${head} · committed changes only${current(!!t && !t.workTree)}`,
      side: 'head',
    },
    // Each branch with the commit it points to; the commits below carry the branch names.
    ...section(
      'Another branch (checked out in a git worktree, or here)',
      branches
        .filter((b) => b.name !== head)
        .map((b) => ({
          label: `$(git-branch) ${b.name}`,
          description: branchCommit(b),
          ref: b.name,
        })),
    ),
    ...section(
      'Recent commits',
      commits.slice(1).map((c) => ({
        label: `$(git-commit) ${commitLabel(c)}`,
        description: c.subject,
        ref: c.short,
      })),
    ),
  ];
  const qp = vscode.window.createQuickPick<Item>();
  qp.items = items;
  qp.matchOnDescription = true;
  qp.title = 'Compare side of the comparison';
  qp.placeholder =
    'The working tree, HEAD only, or another branch or commit (or type any git ref, or paste a pull request address)';
  const picked = await new Promise<Item | string | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0] ?? (qp.value.trim() || undefined));
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
  if (!picked) return undefined;
  // A pull request's address: its base and head, as Open Pull Request by Its Address does.
  if (typeof picked === 'string' && parsePullUrl(picked)) {
    void vscode.commands.executeCommand('reviewDesk.github.openUrl', picked);
    return undefined;
  }
  if (typeof picked !== 'string' && picked.side) return { kind: picked.side };
  const ref = typeof picked === 'string' ? picked : picked.ref!;
  const mode = await prompts.pickPlace({ root, ref, title: `Compare side: ${ref}` });
  return mode && { kind: 'ref', ref, mode };
}

/**
 * Makes `side` the compare side, keeping the base: restarts the review on the working tree or
 * on HEAD, checks the ref out here and reviews it, or checks it out in a worktree and opens
 * that in a new window, which starts the same comparison there (a branch another worktree
 * has is reviewed in that one's window).
 */
export async function applyRight(
  controller: ReviewController,
  start: Start,
  side: RightSide,
  prompts: Prompts,
): Promise<boolean> {
  const cwd = controller.target?.root ?? controller.workspaceCwd();
  const root = cwd && (await repoRoot(cwd).catch(() => undefined));
  if (!root) {
    showWarning('Review Desk: open a git repository first.');
    return false;
  }
  const left = { base: controller.target?.base.ref, baseSource: controller.baseChoice?.source };
  try {
    if (side.kind !== 'ref') {
      return await start({ ...left, cwd: root, workTree: side.kind === 'workTree', open: false });
    }
    const out = await checkOut(
      {
        root,
        ref: side.ref,
        place: side.mode,
        purpose: 'compare',
        start: { ...left, workTree: true },
      },
      prompts,
    );
    if (!out) return false;
    if (!out.here) return true;
    return await start({ ...left, cwd: root, workTree: controller.target?.workTree, open: false });
  } catch (e) {
    showError(
      `Review Desk: could not use ${side.kind === 'ref' ? side.ref : 'that'} as the compare side. ${errorText(e)}`,
      e,
    );
    return false;
  }
}
