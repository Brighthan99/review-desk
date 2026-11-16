import * as path from 'node:path';
import { gitOrNull } from './git';

/**
 * Whether git ignores every one of `paths` (files or folders under `root`): untracked and
 * matched by .gitignore, .git/info/exclude or core.excludesFile. Build output, test profiles
 * and node_modules change all the time without changing the diff. A tracked file is never
 * ignored, whatever the patterns say.
 */
export async function allIgnored(root: string, paths: string[]): Promise<boolean> {
  const rel = paths.map((p) => path.relative(root, p).split(path.sep).join('/'));
  // The root itself, or something outside it: not for git to say.
  if (rel.some((r) => !r || r.startsWith('../') || path.isAbsolute(r))) return false;
  const wanted = new Set(rel);
  // Exit 1 (none ignored) comes back as null, like a failure: then they count.
  const out = await gitOrNull(root, ['check-ignore', '-z', '--stdin'], [...wanted].join('\0'));
  if (out === null) return false;
  const ignored = new Set(out.split('\0').filter(Boolean));
  return [...wanted].every((r) => ignored.has(r));
}
