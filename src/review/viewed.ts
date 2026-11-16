import * as fs from 'node:fs';
import * as path from 'node:path';
import { git } from './git';
import type { Review } from './model';
import type { ReviewTarget } from './target';

/** A file marked viewed whose right side is the same as then, or has changed since. */
export type ViewedState = 'viewed' | 'changed';

/** Stands for a file that is not on the right side (deleted). */
export const DELETED = 'deleted';

/**
 * The right side's version of each file, as a git blob id: the working tree's content, or the
 * file at HEAD. With `store`, working tree contents are written to the object database too, so
 * the version viewed can be diffed with a later one.
 */
export async function rightBlobs(
  target: ReviewTarget,
  files: string[],
  store = false,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!files.length) return out;
  if (target.workTree) {
    const present = files.filter((f) => fs.existsSync(path.join(target.root, f)));
    for (const f of files) if (!present.includes(f)) out.set(f, DELETED);
    for (let i = 0; i < present.length; i += 100) {
      const chunk = present.slice(i, i + 100);
      const ids = (
        await git(target.root, ['hash-object', ...(store ? ['-w'] : []), '--', ...chunk])
      )
        .trim()
        .split('\n');
      chunk.forEach((f, j) => out.set(f, ids[j]));
    }
    return out;
  }
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100);
    const listed = await git(target.root, ['ls-tree', '-z', target.head.sha, '--', ...chunk]);
    for (const entry of listed.split('\0')) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/.exec(entry);
      if (m) out.set(m[2], m[1]);
    }
  }
  for (const f of files) if (!out.has(f)) out.set(f, DELETED);
  return out;
}

/** Viewed or changed since, for the changed files the reviewer marked viewed. */
export async function viewedStates(
  target: ReviewTarget,
  viewed: Review['viewed'],
): Promise<Map<string, ViewedState>> {
  const states = new Map<string, ViewedState>();
  const changed = new Set(target.files.map((f) => f.newPath ?? f.oldPath!));
  const marked = Object.keys(viewed ?? {}).filter((f) => changed.has(f));
  if (!marked.length) return states;
  const now = await rightBlobs(target, marked);
  for (const f of marked) states.set(f, now.get(f) === viewed![f].blob ? 'viewed' : 'changed');
  return states;
}
