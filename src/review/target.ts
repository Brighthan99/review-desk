import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  filePath,
  formatForAgent,
  parseUnifiedDiff,
  type DiffFile,
  type DiffLine,
} from './diffParser';
import { git, gitOrNull } from './git';

export interface RefInfo {
  ref: string;
  sha: string;
}

export interface ReviewTarget {
  root: string;
  gitDir: string;
  base: RefInfo;
  head: RefInfo;
  files: DiffFile[];
  /** The new side is the working tree (uncommitted edits and new files included), not HEAD. */
  workTree: boolean;
  /** Files whose working tree content differs from HEAD, when `workTree`. */
  uncommitted: string[];
}

export interface TargetOptions {
  /** Compare the base with the working tree instead of HEAD. */
  workTree?: boolean;
}

export class TargetError extends Error {}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/** The commit HEAD is on, or null outside a repository or before its first commit. */
async function headCommit(cwd: string): Promise<string | null> {
  return (
    (await gitOrNull(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() || null
  );
}

/** The default base: the remote's default branch, else a local main/master. */
export async function defaultBaseRef(root: string): Promise<string | null> {
  const remoteHead = await gitOrNull(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead.trim().replace(/^refs\/remotes\//, '');
  for (const ref of ['main', 'master', 'origin/main', 'origin/master']) {
    if (await gitOrNull(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
  }
  return null;
}

/**
 * What to review: the diff from the merge base of `baseRef` and HEAD to HEAD, or to the work
 * tree (with untracked files as added) when `workTree` is set. An empty diff is a valid
 * review: any file can still be explained.
 */
export async function computeTarget(
  cwd: string,
  baseRef?: string,
  options: TargetOptions = {},
): Promise<ReviewTarget> {
  const top = await gitOrNull(cwd, ['rev-parse', '--show-toplevel']);
  if (top === null) throw new TargetError(`${path.basename(cwd)} is not a git repository.`);
  const root = top.trim();
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  const headSha = await headCommit(root);
  if (!headSha) throw new TargetError(`${path.basename(root)} has no commits yet.`);
  const ref = baseRef ?? (await defaultBaseRef(root));
  if (!ref) throw new TargetError('No base branch found (main, master or origin/HEAD).');

  const headRef = (await git(root, ['branch', '--show-current'])).trim() || headSha.slice(0, 7);
  const mergeBase = await gitOrNull(root, ['merge-base', ref, 'HEAD']);
  if (!mergeBase) throw new TargetError(`'${ref}' and HEAD have no common ancestor.`);
  const baseSha = mergeBase.trim();

  // The working tree with diff-index, the plumbing: `git diff` rewrites .git/index (its stat
  // cache) whenever a file was touched, taking index.lock even with optional locks off, so
  // a commit made at that moment fails. Two commits never touch the index.
  const diff = await git(root, [
    options.workTree ? 'diff-index' : 'diff',
    ...(options.workTree ? ['-p'] : []),
    '--no-ext-diff',
    '--no-textconv',
    '-M',
    '-U3',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    baseSha,
    ...(options.workTree ? [] : [headSha]),
  ]);
  const files = parseUnifiedDiff(diff);
  let uncommitted: string[] = [];
  if (options.workTree) {
    const list = async (args: string[]) => (await git(root, args)).split('\0').filter(Boolean);
    const untracked = await list(['ls-files', '--others', '--exclude-standard', '-z']);
    files.push(...untracked.map((p) => untrackedFile(root, p)));
    // Files whose content differs from HEAD (numstat compares content: one only touched is
    // not listed, as `git diff --name-only` leaves it out).
    const changed = (await list(['diff-index', '--numstat', '-z', 'HEAD'])).map((entry) =>
      entry.split('\t').slice(2).join('\t'),
    );
    uncommitted = [...new Set([...changed, ...untracked])];
  }

  return {
    root,
    gitDir,
    base: { ref, sha: baseSha },
    head: { ref: headRef, sha: headSha },
    files,
    workTree: options.workTree ?? false,
    uncommitted,
  };
}

/** An untracked file as an added file in the diff. */
function untrackedFile(root: string, p: string): DiffFile {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path.join(root, p));
  } catch {
    buf = Buffer.alloc(0);
  }
  const binary = buf.subarray(0, 8000).includes(0) || buf.length > 2_000_000;
  const text = binary ? [] : buf.toString('utf8').split('\n');
  const noNewline = text.length > 0 && text[text.length - 1] !== '';
  if (!noNewline) text.pop();
  const lines = text.map((t, i): DiffLine => ({
    kind: 'add',
    oldLine: null,
    newLine: i + 1,
    text: t.endsWith('\r') ? t.slice(0, -1) : t,
  }));
  if (noNewline && lines.length) lines[lines.length - 1].noNewlineAtEnd = true;
  return {
    oldPath: null,
    newPath: p,
    status: 'added',
    binary,
    hunks: lines.length
      ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, section: '', lines }]
      : [],
    additions: lines.length,
    deletions: 0,
  };
}

export function findFile(target: ReviewTarget, path: string): DiffFile | undefined {
  return target.files.find((f) => filePath(f) === path || f.oldPath === path);
}

/** File content on one side of the review, split into lines (index 0 = line 1). */
export async function readSide(
  target: ReviewTarget,
  side: 'old' | 'new',
  file: string,
): Promise<string[] | null> {
  const f = findFile(target, file);
  const p = side === 'old' ? (f?.oldPath ?? file) : (f?.newPath ?? file);
  let text: string | null;
  if (side === 'new' && target.workTree) {
    try {
      text = fs.readFileSync(path.join(target.root, p), 'utf8');
    } catch {
      text = null;
    }
  } else {
    text = await showAt(target.root, side === 'old' ? target.base.sha : target.head.sha, p);
  }
  if (text === null) return null;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** File contents at a commit, which never change, most recently used last. */
const atCommit = new Map<string, string | null>();
const MAX_AT_COMMIT = 200;
/** Larger files are read again each time rather than kept. */
const MAX_KEPT_CHARS = 1_000_000;

/** `git show <sha>:<path>`, kept: notes are re-anchored on every reload. */
async function showAt(root: string, sha: string, file: string): Promise<string | null> {
  const key = `${root}\0${sha}:${file}`;
  if (atCommit.has(key)) {
    const text = atCommit.get(key)!;
    atCommit.delete(key);
    atCommit.set(key, text);
    return text;
  }
  const text = await gitOrNull(root, ['show', `${sha}:${file}`]);
  if (text === null || text.length <= MAX_KEPT_CHARS) {
    atCommit.set(key, text);
    if (atCommit.size > MAX_AT_COMMIT) atCommit.delete(atCommit.keys().next().value!);
  }
  return text;
}

/**
 * A fingerprint of one file as the review sees it: its diff when it changed, else its content
 * (`lines`, from `readSide`), to tell when a summary of the file is out of date.
 */
export function fileDigest(target: ReviewTarget, file: string, lines: string[] | null): string {
  const changed = findFile(target, file);
  return createHash('sha1')
    .update(changed ? formatForAgent([changed]) : (lines ?? []).join('\n'))
    .digest('hex')
    .slice(0, 16);
}

const digests = new WeakMap<ReviewTarget, string>();

/** A fingerprint of the change (base and diff), to tell when a summary of it is out of date. */
export function diffDigest(target: ReviewTarget): string {
  let digest = digests.get(target);
  if (!digest) {
    digest = createHash('sha1')
      .update(target.base.sha)
      .update(formatForAgent(target.files))
      .digest('hex')
      .slice(0, 16);
    digests.set(target, digest);
  }
  return digest;
}
