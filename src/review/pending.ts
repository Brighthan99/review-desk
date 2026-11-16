import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BaseSource } from './branchBase';
import { git } from './git';
import type { GitHubInfo } from './model';

/**
 * A review another window asked this folder's window to start: left in the folder's git dir
 * by a checkout into a new worktree (a pull request, or a side picked to compare), for the
 * new window of that folder or for this window once the folder is added to it.
 */
export interface PendingStart {
  base?: string;
  baseSource?: BaseSource;
  /** The pull request the review is for. */
  github?: GitHubInfo;
  workTree?: boolean;
}

const PENDING = 'review-desk-pending.json';

async function pendingFile(dir: string): Promise<string> {
  return path.join((await git(dir, ['rev-parse', '--absolute-git-dir'])).trim(), PENDING);
}

export async function leavePending(dir: string, start: PendingStart): Promise<void> {
  fs.writeFileSync(await pendingFile(dir), JSON.stringify(start));
}

/** The review left for this folder, if any (not a repository: none). */
export async function readPending(dir: string): Promise<PendingStart | undefined> {
  const file = await pendingFile(dir).catch(() => undefined);
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PendingStart;
  } catch {
    fs.rmSync(file, { force: true });
    return undefined;
  }
}

/**
 * Forgets the review left for this folder, once it started (or failed to): removed only
 * then, so a window whose extensions restart meanwhile (adding a second folder to a window
 * does that) still finds it.
 */
export async function clearPending(dir: string): Promise<void> {
  const file = await pendingFile(dir).catch(() => undefined);
  if (file) fs.rmSync(file, { force: true });
}
