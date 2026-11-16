import { filePath } from './diffParser';
import { gitOrNull } from './git';
import type { ReviewTarget } from './target';

/**
 * One row of the comparison drawn as a branch: newest first, the base, then a few commits
 * from before the base (not compared; there to move the base back to).
 */
export type HistoryRow =
  | { kind: 'uncommitted'; files: number; added: number }
  | {
      kind: 'commit' | 'base' | 'earlier';
      sha: string;
      short: string;
      subject: string;
      refs: string[];
    }
  | { kind: 'more'; count: number }
  | { kind: 'ahead'; ref: string; count: number };

/** The log format `parseLogLine` reads: SHA, short SHA, decorations, subject. */
export const LOG_FORMAT = '--format=%H%x09%h%x09%D%x09%s';

/** `%D` decorations as names: "HEAD -> main, tag: v1" → ["HEAD", "main", "v1"]. */
function refsOf(decorations: string): string[] {
  return decorations
    .split(', ')
    .filter(Boolean)
    .flatMap((d) => d.split(' -> '))
    .map((d) => d.replace(/^tag: /, ''));
}

/** A line of `git log` in `LOG_FORMAT`. */
export function parseLogLine(line: string) {
  const [sha, short, decorations, ...subject] = line.split('\t');
  return { sha, short, refs: refsOf(decorations ?? ''), subject: subject.join('\t') };
}

/**
 * What the review compares, as a branch: uncommitted changes on top (the right side when
 * the working tree is reviewed), the commits from HEAD down, and the base commit (the left
 * side: where the branch left the chosen base). A base branch that has moved on since is
 * noted after it.
 */
export async function comparisonHistory(
  target: ReviewTarget,
  max = 15,
  earlier = 5,
): Promise<HistoryRow[]> {
  const { root, base, head } = target;
  const rows: HistoryRow[] = [];
  if (target.workTree && target.uncommitted.length) {
    const added = target.files.filter(
      (f) => f.status === 'added' && target.uncommitted.includes(filePath(f)),
    ).length;
    rows.push({ kind: 'uncommitted', files: target.uncommitted.length, added });
  }

  const range = `${base.sha}..${head.sha}`;
  const log = (await gitOrNull(root, ['log', `--max-count=${max}`, LOG_FORMAT, range])) ?? '';
  rows.push(
    ...log
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ kind: 'commit' as const, ...parseLogLine(l) })),
  );
  const total = Number((await gitOrNull(root, ['rev-list', '--count', range]))?.trim() ?? 0);
  if (total > max) rows.push({ kind: 'more', count: total - max });

  const baseLine = await gitOrNull(root, ['log', '-1', LOG_FORMAT, base.sha]);
  if (baseLine?.trim()) rows.push({ kind: 'base', ...parseLogLine(baseLine.trim()) });

  if (base.ref !== 'HEAD') {
    const ahead = await gitOrNull(root, ['rev-list', '--count', `${base.sha}..${base.ref}`]);
    const count = Number(ahead?.trim() ?? 0);
    if (count > 0) rows.push({ kind: 'ahead', ref: base.ref, count });
  }

  // The commits before the base (its first parents), so a base moved forward can go back.
  if (earlier > 0) {
    const before = await gitOrNull(root, [
      'log',
      '--first-parent',
      `--max-count=${earlier}`,
      LOG_FORMAT,
      `${base.sha}^`,
    ]);
    for (const line of (before ?? '').split('\n').filter(Boolean)) {
      rows.push({ kind: 'earlier', ...parseLogLine(line) });
    }
  }
  return rows;
}
