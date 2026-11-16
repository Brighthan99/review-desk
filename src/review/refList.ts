import { gitOrNull } from './git';
import { LOG_FORMAT, parseLogLine } from './history';

/** A branch to compare with, local or remote, and the commit it points to. */
export interface BranchRef {
  name: string;
  short: string;
  subject: string;
  /** The branch checked out in this folder. */
  checkedOut: boolean;
}

/** A recent commit, with the branches and tags that point to it. */
export interface CommitRef {
  sha: string;
  short: string;
  subject: string;
  refs: string[];
}

/**
 * The local and remote branches, each with its commit. Symbolic refs are left out: a
 * remote's HEAD (`origin/HEAD`) would show as a branch named `origin`.
 */
export async function branchRefs(root: string): Promise<BranchRef[]> {
  const out = await gitOrNull(root, [
    'for-each-ref',
    '--format=%(refname:short)%09%(symref)%09%(objectname:short)%09%(HEAD)%09%(contents:subject)',
    'refs/heads',
    'refs/remotes',
  ]);
  return (out ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, symref]) => !symref)
    .map(([name, , short, head, ...subject]) => ({
      name,
      short,
      subject: subject.join('\t'),
      checkedOut: head === '*',
    }));
}

/** The latest commits of HEAD, each with the branch and tag names on it. */
export async function recentCommits(root: string, count = 30): Promise<CommitRef[]> {
  const out = await gitOrNull(root, ['log', `--max-count=${count}`, LOG_FORMAT]);
  return (out ?? '')
    .split('\n')
    .filter(Boolean)
    .map(parseLogLine)
    .map((c) => ({ ...c, refs: c.refs.filter((r) => !r.endsWith('/HEAD')) }));
}

/**
 * A commit as a list shows it: its short SHA, and the branches and tags on it the way
 * `git log --oneline --decorate` does, so a branch's place among the commits is seen and
 * typing its name finds the commit too: `8bf9211 (HEAD, main, origin/main)`.
 */
export function commitLabel(c: CommitRef): string {
  return c.refs.length ? `${c.short} (${c.refs.join(', ')})` : c.short;
}

/** Where a branch points, for the line beside its name: `8bf9211 Merge pull request #10…`. */
export function branchCommit(b: BranchRef): string {
  return `${b.short} ${b.subject}`;
}
