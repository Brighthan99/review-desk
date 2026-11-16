import { git, gitOrNull } from './git';
import { worktreeOf } from './worktree';

/** The branch a repository's work starts from and comes back to, and the remote that has it. */
export interface HomeBranch {
  branch: string;
  /** The remote whose HEAD names it (origin first); none for a repository without one. */
  remote?: string;
}

const exists = async (root: string, ref: string) =>
  (await gitOrNull(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null;

/**
 * The repository's default branch: the one a remote's HEAD names (origin first, as set by
 * clone or `git remote set-head`), else a local main or master.
 */
export async function homeBranch(root: string): Promise<HomeBranch | undefined> {
  const remotes = ((await gitOrNull(root, ['remote'])) ?? '').split('\n').filter(Boolean);
  remotes.sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  for (const remote of remotes) {
    const head = (
      await gitOrNull(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
    )?.trim();
    if (head?.startsWith(`${remote}/`)) return { branch: head.slice(remote.length + 1), remote };
  }
  for (const branch of ['main', 'master']) {
    if (await exists(root, `refs/heads/${branch}`)) return { branch };
  }
  return undefined;
}

/** Where the home branch is up to date: the remote's copy when there is one, else the local one. */
export function homeRef(home: HomeBranch): string {
  return home.remote ? `${home.remote}/${home.branch}` : home.branch;
}

/**
 * Brings the home branch up to date with its remote: fetches it, then moves the local one
 * forward when it only lags behind (git refuses otherwise, and when it is checked out
 * somewhere; then it stays as it is). Returns whether the local branch is now the remote's.
 */
export async function updateHome(root: string, home: HomeBranch): Promise<boolean> {
  if (!home.remote) return true;
  await gitOrNull(root, ['fetch', '--quiet', home.remote, home.branch]);
  if (!(await exists(root, `refs/heads/${home.branch}`))) return false;
  await gitOrNull(root, [
    'fetch',
    '--quiet',
    home.remote,
    `refs/heads/${home.branch}:refs/heads/${home.branch}`,
  ]);
  const [local, remote] = await Promise.all(
    [home.branch, homeRef(home)].map(async (r) =>
      (await gitOrNull(root, ['rev-parse', r]))?.trim(),
    ),
  );
  return !!local && local === remote;
}

/**
 * Whether every commit of `branch` is in `into`, so deleting it loses nothing. A branch
 * merged by squash or rebase on GitHub is not: its commits were copied, not taken in.
 */
export async function mergedInto(root: string, branch: string, into: string): Promise<boolean> {
  const n = await gitOrNull(root, ['rev-list', '--count', `${into}..refs/heads/${branch}`]);
  return n?.trim() === '0';
}

/**
 * Deletes a local branch whose every commit is in `into`, checked again right before, and
 * only as long as it is still that commit. Not `git branch -d`: that looks at HEAD (or the
 * branch's upstream) instead of `into`, and refuses whenever they lag behind it, as a main
 * checked out in another folder does (its window has to pull it). Refuses a branch checked
 * out anywhere.
 */
export async function deleteMergedBranch(
  root: string,
  branch: string,
  into: string,
): Promise<void> {
  // The branch it is measured against (main into origin/main): never deleted as merged.
  if (into === branch || into.endsWith(`/${branch}`)) {
    throw new Error(`${branch} is the branch the others are merged into.`);
  }
  const ref = `refs/heads/${branch}`;
  const sha = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const holder = await worktreeOf(root, branch);
  if (holder) throw new Error(`${branch} is checked out in ${holder}.`);
  const n = Number((await git(root, ['rev-list', '--count', `${into}..${sha}`])).trim());
  if (n) throw new Error(`${branch} has ${n} ${n === 1 ? 'commit' : 'commits'} ${into} does not.`);
  await git(root, ['update-ref', '-d', ref, sha]);
  // Its settings (upstream, the pull request it is for) go with it, as with git branch -d.
  await gitOrNull(root, ['config', '--remove-section', `branch.${branch}`]);
}
