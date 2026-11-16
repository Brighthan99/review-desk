import { gitOrNull } from './git';

/** Where the branch a folder has out stands against the remote, as of the last fetch or push. */
export interface Sync {
  /**
   * The remote branch `git push` sends the branch to (origin/feat/x), when the remote has it:
   * pushed before. Not the upstream as such: a branch made from origin/main tracks that.
   */
  remote?: string;
  /** Commits to push: ahead of that remote branch, or, without one, on no remote at all. */
  ahead: number;
  /** Commits to pull: behind that remote branch (none without one). */
  behind: number;
}

/**
 * How the branch checked out in `dir` (or its detached HEAD) stands against the remote. None
 * in a repository with no remote, where nothing is ever pushed.
 */
export async function syncOf(dir: string): Promise<Sync | undefined> {
  if (!(await gitOrNull(dir, ['remote']))?.trim()) return undefined;
  const branch = (await gitOrNull(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim();
  const ref = branch ? `refs/heads/${branch}` : 'HEAD';
  // Where git push would send it (push.default, pushRemote): none for a branch never pushed,
  // one whose upstream has another name (made from origin/main), or one gone from the remote.
  const pushTo = branch
    ? (
        await gitOrNull(dir, [
          ...['rev-parse', '--abbrev-ref', '--symbolic-full-name'],
          `${branch}@{push}`,
        ])
      )?.trim()
    : undefined;
  const remote =
    pushTo && (await gitOrNull(dir, ['rev-parse', '--verify', '--quiet', `${pushTo}^{commit}`]))
      ? pushTo
      : undefined;
  if (remote) {
    const counts = await gitOrNull(dir, [
      ...['rev-list', '--left-right', '--count'],
      `${remote}...${ref}`,
    ]);
    const [behind = 0, ahead = 0] = (counts ?? '').trim().split(/\s+/).map(Number);
    return { remote, ahead, behind };
  }
  const n = await gitOrNull(dir, ['rev-list', '--count', ref, '--not', '--remotes']);
  return { ahead: Number(n?.trim() || 0), behind: 0 };
}

/**
 * Short, beside a branch: ↑2 ↓1, or ↑3 not pushed. Empty in sync, which the row's icon shows
 * by its color (see syncColor), as it does the others.
 */
export function syncLabel(s: Sync | undefined): string {
  if (!s) return '';
  if (!s.remote) return s.ahead ? `↑${s.ahead} not pushed` : '';
  const parts = [s.ahead ? `↑${s.ahead}` : '', s.behind ? `↓${s.behind}` : ''].filter(Boolean);
  return parts.join(' ');
}

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** The same in a sentence, for a tooltip. Empty in a repository with no remote. */
export function syncNote(s: Sync | undefined): string {
  if (!s) return '';
  if (!s.remote) {
    return s.ahead
      ? `Not pushed: ${commits(s.ahead)} on no remote yet. Push to share ${s.ahead === 1 ? 'it' : 'them'}.`
      : 'No remote branch of its own; every commit is on a remote already.';
  }
  const asOf = ' (as of the last fetch or push)';
  if (!s.ahead && !s.behind) return `In sync with ${s.remote}${asOf}.`;
  const parts = [
    s.ahead ? `${commits(s.ahead)} to push to ${s.remote}` : '',
    s.behind ? `${commits(s.behind)} to pull from ${s.ahead ? 'it' : s.remote}` : '',
  ].filter(Boolean);
  return `${parts.join(', ')}${asOf}.`;
}
