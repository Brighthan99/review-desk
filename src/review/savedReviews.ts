import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Review } from './model';
import { readReviewFile } from './store';

/** The latest saved review of one branch. */
export interface SavedReview {
  review: Review;
  /** Review file of the branch's most recent head. */
  file: string;
  /** Modification time of that file, in ms. */
  updated: number;
  /** All review files of the branch (one per head it was reviewed at). */
  files: string[];
}

const REVIEW_FILE = /^[0-9a-f]{40,64}\.json$/;

/** Review files kept per branch: the newest few heads (see `pruneBranchReviews`). */
export const KEEP_PER_BRANCH = 3;

/** Parsed review files by path, reused while the file's modification time is the same. */
const parsed = new Map<string, { mtime: number; review: Review | undefined }>();

function readCached(file: string): { review: Review | undefined; mtime: number } {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = parsed.get(file);
  if (hit?.mtime === mtime) return hit;
  const loaded = readReviewFile(file);
  const entry = { mtime, review: loaded.kind === 'ok' ? loaded.review : undefined };
  parsed.set(file, entry);
  return entry;
}

/**
 * The reviews saved under a store directory (<git-dir>/review-desk), one per branch: a branch
 * reviewed at several heads has a file per head, and the newest one stands for it.
 * Newest first. Unreadable files are skipped.
 */
export function listSavedReviews(storeDir: string): SavedReview[] {
  let names: string[];
  try {
    names = fs.readdirSync(storeDir);
  } catch {
    return [];
  }
  const byBranch = new Map<string, SavedReview>();
  for (const name of names) {
    if (!REVIEW_FILE.test(name)) continue;
    const file = path.join(storeDir, name);
    let entry;
    try {
      entry = readCached(file);
    } catch {
      continue;
    }
    const { review, mtime: updated } = entry;
    if (!review) continue;
    const branch = review.head.ref;
    const seen = byBranch.get(branch);
    if (!seen) {
      byBranch.set(branch, { review, file, updated, files: [file] });
    } else {
      seen.files.push(file);
      if (updated > seen.updated) Object.assign(seen, { review, file, updated });
    }
  }
  return [...byBranch.values()].sort((a, b) => b.updated - a.updated);
}

/**
 * Deletes the older review files of a branch, keeping the newest `keep` heads and `protect`
 * (the open one). Each new head carries the notes of the one before, so older files only
 * hold copies; they piled up one per commit. Returns the deleted files.
 */
export function pruneBranchReviews(
  storeDir: string,
  branch: string,
  protect: string,
  keep = KEEP_PER_BRANCH,
): string[] {
  const saved = listSavedReviews(storeDir).find((s) => s.review.head.ref === branch);
  if (!saved) return [];
  const byAge = saved.files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.file);
  const old = byAge.slice(keep).filter((f) => path.resolve(f) !== path.resolve(protect));
  for (const file of old) {
    fs.rmSync(file, { force: true });
    parsed.delete(file);
  }
  return old;
}
