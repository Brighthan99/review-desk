import { git, gitOrNull } from '../review/git';
import type { PullRequest } from './client';
import { parseRemote, type RemoteRepo } from './remote';
import { worktreeOf } from '../review/worktree';

/**
 * The remote that points at the GitHub repository: origin when it does, else the first that
 * does. `isGitHub` tells a GitHub host (github.com, the user's GitHub Enterprise Server).
 */
export async function githubRemote(
  root: string,
  isGitHub: (host: string) => boolean = () => true,
): Promise<{ name: string; repo: RemoteRepo } | undefined> {
  const names = (await git(root, ['remote'])).split('\n').filter(Boolean);
  names.sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  for (const name of names) {
    const url = await gitOrNull(root, ['remote', 'get-url', name]);
    const repo = url ? parseRemote(url) : undefined;
    if (repo && isGitHub(repo.host)) return { name, repo };
  }
  return undefined;
}

/**
 * The remote of `root` that points at `repo`, by its URL as configured (before any
 * `url.<base>.insteadOf` rewriting): origin first.
 */
export async function remoteFor(
  root: string,
  repo: RemoteRepo,
): Promise<{ name: string; repo: RemoteRepo } | undefined> {
  const names = (await git(root, ['remote'])).split('\n').filter(Boolean);
  names.sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (const name of names) {
    const url = await gitOrNull(root, ['config', '--get', `remote.${name}.url`]);
    const r = url ? parseRemote(url) : undefined;
    if (r && same(r.host, repo.host) && same(r.owner, repo.owner) && same(r.repo, repo.repo))
      return { name, repo: r };
  }
  return undefined;
}

export function prBranch(pr: Pick<PullRequest, 'number'>): string {
  return `pr/${pr.number}`;
}

/** Where pr/<n> was last moved to the pull request's head, so later heads can tell its own commits. */
const PULL_HEAD = 'review-desk-pr-head';

/** How bringing pr/<n> up to the pull request's head would move it. */
export interface PullUpdate {
  branch: string;
  /** The pull request's head, just fetched. */
  head: string;
  /** Where the branch is now; none when there is none yet. */
  current?: string;
  /** The worktree that has the branch checked out (this folder too), if any. */
  holder?: string;
  /**
   * Commits of the branch that neither this head nor the head it was last moved to has:
   * made on it here, or another branch of the same name. Moving it takes them off.
   */
  own: number;
}

/**
 * Fetches a pull request: its head (without moving pr/<n> yet; see `movePullBranch`) and its
 * base into <remote>/<base>. Returns the base ref to review against and how pr/<n> would move.
 */
export async function fetchPullRequest(
  root: string,
  remote: string,
  pr: PullRequest,
): Promise<{ base: string; update: PullUpdate }> {
  const branch = prBranch(pr);
  await git(root, ['fetch', remote, `refs/pull/${pr.number}/head`]);
  const head = (await git(root, ['rev-parse', 'FETCH_HEAD^{commit}'])).trim();
  await git(root, [
    'fetch',
    remote,
    `+refs/heads/${pr.base.ref}:refs/remotes/${remote}/${pr.base.ref}`,
  ]);
  const update: PullUpdate = { branch, head, own: 0 };
  update.current = await branchSha(root, branch);
  if (update.current) {
    update.holder = await worktreeOf(root, branch);
    const last = (
      await gitOrNull(root, ['config', '--get', `branch.${branch}.${PULL_HEAD}`])
    )?.trim();
    const known =
      last && (await gitOrNull(root, ['rev-parse', '--verify', '--quiet', `${last}^{commit}`]));
    const not = known ? [head, known.trim()] : [head];
    const n = await git(root, ['rev-list', '--count', update.current, '--not', ...not]);
    update.own = Number(n.trim());
  }
  return { base: `${remote}/${pr.base.ref}`, update };
}

/** A free branch name to keep pr/<n>'s own commits on: pr/<n>-before, pr/<n>-before-2, … */
export async function keepName(root: string, branch: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${branch}-before` : `${branch}-before-${n}`;
    if (!(await branchSha(root, name))) return name;
  }
}

/**
 * Moves pr/<n> to the pull request's head (made when there is none): the worktree that has
 * it checked out moves too, keeping its uncommitted changes (git stops when they clash).
 * Its own commits are kept on `keepAs` first, when given. Refuses when the branch moved since
 * `fetchPullRequest` looked at it, so no commit made meanwhile is taken off unasked.
 */
export async function movePullBranch(root: string, u: PullUpdate, keepAs?: string): Promise<void> {
  const ref = `refs/heads/${u.branch}`;
  if ((await branchSha(root, u.branch)) !== u.current) {
    throw new Error(`${u.branch} changed meanwhile. Open the pull request again.`);
  }
  const kept = keepAs && u.current ? { ref: `refs/heads/${keepAs}`, sha: u.current } : undefined;
  if (kept) await git(root, ['update-ref', kept.ref, kept.sha, '']);
  try {
    if (u.current !== u.head) {
      // git refuses to update a branch checked out somewhere: that worktree moves instead.
      if (u.holder) await git(u.holder, ['reset', '--keep', u.head]);
      else await git(root, ['update-ref', ref, u.head, u.current ?? '']);
    }
  } catch (e) {
    // Not moved (uncommitted changes in the way): its commits are still on it.
    if (kept) await gitOrNull(root, ['update-ref', '-d', kept.ref, kept.sha]);
    throw e;
  }
  await git(root, ['config', `branch.${u.branch}.${PULL_HEAD}`, u.head]);
}

async function branchSha(root: string, branch: string): Promise<string | undefined> {
  const sha = await gitOrNull(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return sha?.trim() || undefined;
}

/**
 * The PR a branch was checked out for by the GitHub Pull Requests extension, which records
 * `branch.<name>.github-pr-owner-number = owner#repo#number` in the git config.
 */
export function parseGhprConfig(
  value: string | null,
): { owner: string; repo: string; number: number } | undefined {
  const m = /^([^#\s]+)#([^#\s]+)#(\d+)$/.exec((value ?? '').trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

export async function ghprBranchPr(root: string, branch: string) {
  return parseGhprConfig(
    await gitOrNull(root, ['config', '--get', `branch.${branch}.github-pr-owner-number`]),
  );
}
