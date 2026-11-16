import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { rememberPrTarget } from '../review/branchBase';
import { gitOrNull } from '../review/git';
import { branchCommit, branchRefs, commitLabel, recentCommits } from '../review/refList';
import { applyRight, pickRight, type RightSide } from '../ui/compareSides';
import type { Place } from '../ui/place';
import type { Command, Services } from './services';

/** The sides of the comparison: the base, the compare side, and the commit rows between. */
export function registerCompareCommands(command: Command, s: Services): void {
  const { controller, prompts, worktrees, start } = s;
  // Pick what to compare with, also in the middle of a review (the base row of the list).
  // `remember` also records the base as the PR target of the current branch (gh-merge-base).
  const changeBase = async (base?: unknown, remember?: boolean) => {
    const picked =
      typeof base === 'string' ? { ref: base, remember: !!remember } : await pickBase(controller);
    if (!picked) return false;
    if (picked.remember) {
      const cwd = controller.target?.root ?? controller.workspaceCwd();
      const branch = cwd && (await gitOrNull(cwd, ['branch', '--show-current']))?.trim();
      if (cwd && branch) await rememberPrTarget(cwd, branch, picked.ref);
    }
    return start({
      base: picked.ref,
      baseSource: picked.remember ? 'gh-merge-base' : 'picked',
      workTree: controller.target?.workTree,
    });
  };
  command('reviewDesk.changeBase', changeBase);
  command('reviewDesk.startWithBase', changeBase);
  // The commit rows of the comparison: make that commit the base…
  command('reviewDesk.compareFrom', (row: { row: { sha: string } }) => changeBase(row.row.sha));
  // …or the right one, checked out in a worktree or here (tests pass where).
  const changeRight = async (side?: RightSide) => {
    const picked = side ?? (await pickRight(controller, prompts));
    if (!picked) return false;
    const ok = await applyRight(controller, start, picked, prompts);
    if (picked.kind === 'ref') worktrees.refresh();
    return ok;
  };
  command('reviewDesk.changeRight', changeRight);
  command('reviewDesk.compareTo', async (row: { row: { sha: string } }, mode?: Place) => {
    // HEAD as the compare side is the review of HEAD only, here.
    const { sha } = row.row;
    if (sha === controller.target?.head.sha) return changeRight({ kind: 'head' });
    const root = controller.target?.root;
    const where =
      mode ??
      (root &&
        (await prompts.pickPlace({ root, ref: sha, title: `Compare side: ${sha.slice(0, 7)}` })));
    return where ? changeRight({ kind: 'ref', ref: sha, mode: where }) : false;
  });
  // A commit row clicked: make it a side, or copy its SHA (tests pass the choice).
  command(
    'reviewDesk.commitActions',
    async (
      arg: { row: { kind: string; sha: string; short: string; subject: string } },
      choice?: 'left' | 'right' | 'copy',
    ) => {
      const { row } = arg;
      const items = [
        {
          label: '$(arrow-left) Compare from Here',
          description: 'make it the base',
          choice: 'left' as const,
        },
        // A commit before the base cannot be the compare side of it.
        ...(row.kind === 'earlier'
          ? []
          : [
              {
                label: '$(arrow-right) Compare up to Here',
                description: 'make it the compare side',
                choice: 'right' as const,
              },
            ]),
        {
          label: '$(copy) Copy Commit SHA',
          description: row.sha.slice(0, 12),
          choice: 'copy' as const,
        },
      ];
      const picked =
        choice ??
        (await vscode.window.showQuickPick(items, { title: `${row.short} ${row.subject}` }))
          ?.choice;
      if (picked === 'left') return changeBase(row.sha);
      if (picked === 'right') {
        return vscode.commands.executeCommand<boolean>('reviewDesk.compareTo', { row });
      }
      if (picked === 'copy') {
        await vscode.env.clipboard.writeText(row.sha);
        void vscode.window.showInformationMessage(`Review Desk: copied ${row.sha.slice(0, 12)}.`);
        return true;
      }
      return false;
    },
  );
  // Both sides at once: which one to change, then that side's picker.
  // The comparison row: which side to change, or a pull request's address pasted in.
  command('reviewDesk.compare', async () => {
    const side = await prompts.pickSide(controller.target);
    if (side === 'base') return changeBase();
    if (side === 'compare') return changeRight();
    if (side === 'pull') return vscode.commands.executeCommand('reviewDesk.github.open');
    if (side) return vscode.commands.executeCommand('reviewDesk.github.openUrl', side.pullUrl);
    return false;
  });
}

/**
 * Lets the reviewer pick what to compare with: HEAD (only uncommitted changes), a branch,
 * a tag, a recent commit, or any ref typed in. A branch's pin button also remembers it as
 * the PR target of the current branch.
 */
async function pickBase(
  controller: ReviewController,
): Promise<{ ref: string; remember: boolean } | undefined> {
  const cwd = controller.target?.root ?? controller.workspaceCwd();
  if (!cwd) return undefined;
  const current = controller.target?.base.ref;
  const head = (await gitOrNull(cwd, ['branch', '--show-current']))?.trim();
  const target =
    head && (await gitOrNull(cwd, ['config', '--get', `branch.${head}.gh-merge-base`]))?.trim();
  const pin: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('pin'),
    tooltip: `Compare with this branch and remember it as the PR target of ${head}`,
  };
  const [branches, tags, commits] = await Promise.all([
    branchRefs(cwd),
    gitOrNull(cwd, ['tag', '--sort=-creatordate']).then((out) =>
      (out ?? '').split('\n').filter(Boolean),
    ),
    recentCommits(cwd),
  ]);
  type Item = vscode.QuickPickItem & { ref?: string };
  const section = (label: string, items: Item[]): Item[] =>
    items.length ? [{ label, kind: vscode.QuickPickItemKind.Separator }, ...items] : [];
  const mark = (ref: string) => (ref === current ? 'current base' : undefined);
  const items: Item[] = [
    { label: 'HEAD', description: 'only uncommitted changes', detail: mark('HEAD'), ref: 'HEAD' },
    // Each branch with the commit it points to; the commits below carry the branch names.
    ...section(
      'Branches',
      branches.map((b) => ({
        label: b.name,
        description: [
          b.checkedOut ? 'checked out here' : undefined,
          mark(b.name),
          b.name === target || b.name.endsWith(`/${target}`) ? 'PR target' : undefined,
          branchCommit(b),
        ]
          .filter(Boolean)
          .join(' · '),
        ref: b.name,
        buttons: head ? [pin] : [],
      })),
    ),
    ...section(
      'Tags',
      tags.slice(0, 20).map((r) => ({ label: r, description: mark(r), ref: r })),
    ),
    ...section(
      'Recent commits',
      commits.map((c) => ({
        label: commitLabel(c),
        description: c.subject,
        detail: current === c.sha || current === c.short ? 'current base' : undefined,
        ref: c.short,
      })),
    ),
  ];
  const qp = vscode.window.createQuickPick<Item>();
  qp.items = items;
  qp.matchOnDescription = true;
  qp.title = `Compare ${controller.target?.head.ref ?? 'this branch'} with…`;
  qp.placeholder = 'Pick a branch, tag or commit, or type any git ref (e.g. HEAD~3)';
  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      const ref = qp.selectedItems[0]?.ref ?? qp.value.trim();
      if (!ref) return;
      resolve({ ref, remember: false });
      qp.hide();
    });
    qp.onDidTriggerItemButton((e) => {
      if (!e.item.ref) return;
      resolve({ ref: e.item.ref, remember: true });
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}
