import { git, gitOrNull } from './git';
import { listSavedReviews } from './savedReviews';
import { storeDir } from './store';

/** Where the base of a review came from, strongest first when none is picked. */
export type BaseSource = 'picked' | 'pr' | 'gh-merge-base' | 'last-review' | 'setting' | 'default';

export interface BaseChoice {
  ref: string;
  source: BaseSource;
  /** E.g. the PR number for `pr`. */
  detail?: string;
}

/**
 * A branch name as a ref to compare with: its remote-tracking branch when there is one
 * (that is what a PR merges into), else the local branch.
 */
export async function branchRef(root: string, name: string): Promise<string | undefined> {
  for (const ref of [`origin/${name}`, name]) {
    if (await gitOrNull(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
  }
  return undefined;
}

/**
 * The PR target a branch has on record: GitHub CLI's per-branch setting
 * (`branch.<name>.gh-merge-base`, also what `gh pr create` uses), else the base of the
 * branch's last saved review.
 */
export async function recordedBase(
  root: string,
  gitDir: string,
  branch: string,
): Promise<BaseChoice | undefined> {
  const gh = (await gitOrNull(root, ['config', '--get', `branch.${branch}.gh-merge-base`]))?.trim();
  if (gh) {
    const ref = await branchRef(root, gh);
    if (ref) return { ref, source: 'gh-merge-base', detail: gh };
  }
  const last = listSavedReviews(storeDir(gitDir)).find((s) => s.review.head.ref === branch);
  return last ? { ref: last.review.base.ref, source: 'last-review' } : undefined;
}

/** Records `ref` as the PR target of `branch`, as `gh` does (the branch name, no remote). */
export async function rememberPrTarget(root: string, branch: string, ref: string): Promise<void> {
  const remotes = ((await gitOrNull(root, ['remote'])) ?? '').split('\n').filter(Boolean);
  const remote = remotes.find((r) => ref.startsWith(`${r}/`));
  const name = remote ? ref.slice(remote.length + 1) : ref;
  await git(root, ['config', `branch.${branch}.gh-merge-base`, name]);
}
