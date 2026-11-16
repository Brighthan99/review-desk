import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseReview, type Review } from './model';

export type LoadResult =
  { kind: 'missing' } | { kind: 'ok'; review: Review } | { kind: 'invalid'; error: string };

export function readReviewFile(file: string): LoadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { kind: 'invalid', error: `Invalid JSON: ${(e as Error).message}` };
  }
  const parsed = parseReview(json);
  return 'review' in parsed
    ? { kind: 'ok', review: parsed.review }
    : { kind: 'invalid', error: parsed.error };
}

export function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Calls `onChange` (debounced) whenever `dir/name` is written. fs.watch can miss events
 * (macOS FSEvents under load), so the file's mtime is also checked once a second.
 */
export function watchFile(
  dir: string,
  name: string,
  onChange: () => void,
  watch: typeof fs.watch = fs.watch,
): { dispose(): void } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const mtime = () => mtimeOf(file);
  let seen = mtime();
  let timer: NodeJS.Timeout | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      seen = mtime();
      onChange();
    }, 100);
  };
  // Watching can fail (EMFILE: too many open files), at once or later: the poll below goes on.
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename === null || filename === name) fire();
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    watcher = undefined;
  }
  const poll = setInterval(() => {
    if (mtime() !== seen) fire();
  }, 1000);
  return {
    dispose: () => {
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    },
  };
}

/** The directory under the git dir that holds the reviews. */
export const STORE_DIR = 'review-desk';
/** Where the reviews were kept under the extension's earlier name (Erudite). */
const LEGACY_STORE_DIR = 'erudite';

/**
 * The git dir all worktrees of a repository share: a linked worktree's own git dir
 * (<repo>/.git/worktrees/<name>) names it in its `commondir` file; the main one is its own.
 */
export function commonGitDir(gitDir: string): string {
  try {
    const rel = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return rel ? path.resolve(gitDir, rel) : gitDir;
  } catch {
    return gitDir;
  }
}

/** Whether `gitDir` is a linked worktree's (made by git worktree add), not a repository's own. */
export function isLinkedWorktree(gitDir: string): boolean {
  return commonGitDir(gitDir) !== gitDir;
}

/** The folder of the repository a linked worktree was made from: where its common git dir is. */
export function mainFolderOf(gitDir: string): string {
  return path.dirname(commonGitDir(gitDir));
}

/**
 * Moves the review files of `from` into `to`; a file `to` already has stays in `from`. The
 * folder goes away once empty.
 */
function moveReviews(from: string, to: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(from);
  } catch {
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const name of names) {
    const target = path.join(to, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.renameSync(path.join(from, name), target);
    } catch {
      // Left where it is: still read from there next time.
    }
  }
  try {
    fs.rmdirSync(from);
  } catch {
    // Not empty (a review both places had): kept.
  }
}

/**
 * The review directory of a repository: <common git dir>/review-desk, shared by all its
 * worktrees, so removing a worktree never removes the reviews written in it. Reviews kept
 * where they used to be (a worktree's own git dir, or under the earlier name Erudite) are
 * moved here the first time.
 */
export function storeDir(gitDir: string): string {
  const common = commonGitDir(gitDir);
  const dir = path.join(common, STORE_DIR);
  const legacy = [path.join(common, LEGACY_STORE_DIR)];
  if (common !== gitDir)
    legacy.push(path.join(gitDir, STORE_DIR), path.join(gitDir, LEGACY_STORE_DIR));
  for (const old of legacy) if (fs.existsSync(old)) moveReviews(old, dir);
  return dir;
}

/**
 * The extension's own copy of each review, under the git dir so it never shows in the work
 * tree: <common git dir>/review-desk/<head-sha>.json, one place for all the worktrees of the
 * repository (a review is for a head commit, whichever folder has it checked out).
 */
export class ReviewStore {
  readonly dir: string;
  /** Modification time of each file as this store last wrote it. */
  private readonly written = new Map<string, number>();

  constructor(gitDir: string) {
    this.dir = storeDir(gitDir);
  }

  reviewPath(headSha: string): string {
    return path.join(this.dir, `${headSha}.json`);
  }

  load(headSha: string): LoadResult {
    return readReviewFile(this.reviewPath(headSha));
  }

  /**
   * Writes the review. One that would not read back (the schema refuses it: a line that is no
   * whole number, an empty title) is not written: a file the schema refuses keeps the whole
   * review from opening, until mended by hand.
   */
  save(review: Review): void {
    const checked = parseReview(JSON.parse(JSON.stringify(review)));
    if ('error' in checked) {
      throw new Error(`Review Desk: not saved, the review would not read back.\n${checked.error}`);
    }
    const file = this.reviewPath(review.head.sha);
    writeAtomic(file, JSON.stringify(review, null, 2) + '\n');
    this.written.set(file, mtimeOf(file));
  }

  /**
   * Calls `onChange` when the review file of `headSha` is written by someone else (the agent,
   * the chat's MCP server, another window); this store's own saves are already reloaded.
   */
  watch(headSha: string, onChange: () => void): { dispose(): void } {
    const file = this.reviewPath(headSha);
    return watchFile(this.dir, `${headSha}.json`, () => {
      if (mtimeOf(file) !== this.written.get(file)) onChange();
    });
  }
}
