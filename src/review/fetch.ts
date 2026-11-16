import { git, gitOrNull } from './git';

/** The remote-tracking branches and where they point (origin/HEAD left out: it only names one). */
async function remoteBranches(root: string): Promise<Map<string, string>> {
  const out = await git(root, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/remotes',
  ]);
  return new Map(
    out
      .split('\n')
      .map((l) => l.split(' ') as [string, string])
      .filter(([ref, sha]) => ref && sha && !ref.endsWith('/HEAD'))
      .map(([ref, sha]) => [ref.replace(/^refs\/remotes\//, ''), sha] as const),
  );
}

/**
 * Fetches every remote, pruning branches deleted there, and says what moved: new remote
 * branches, moved ones (with how many commits, when they moved forward) and deleted ones.
 */
export async function fetchAll(root: string): Promise<string[]> {
  const before = await remoteBranches(root);
  await git(root, ['fetch', '--all', '--prune', '--quiet']);
  const after = await remoteBranches(root);
  const changes: string[] = [];
  for (const [ref, sha] of after) {
    const old = before.get(ref);
    if (!old) changes.push(`${ref} new`);
    else if (old !== sha) {
      const n = (await gitOrNull(root, ['rev-list', '--count', `${old}..${sha}`]))?.trim();
      changes.push(
        n && n !== '0' ? `${ref} +${n} ${n === '1' ? 'commit' : 'commits'}` : `${ref} moved`,
      );
    }
  }
  for (const ref of before.keys()) if (!after.has(ref)) changes.push(`${ref} deleted`);
  return changes;
}
