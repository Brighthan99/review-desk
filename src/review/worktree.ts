import * as fs from 'node:fs';
import * as path from 'node:path';
import { git, gitOrNull } from './git';
import { samePath } from './realpath';
import { commonGitDir } from './store';

/** What a ref names: a local branch, a remote branch, or anything else (commit, tag). */
export async function refKind(root: string, ref: string): Promise<'local' | 'remote' | 'other'> {
  // --quiet prints nothing: success (an empty string, not null) is what tells.
  const exists = async (full: string) =>
    (await gitOrNull(root, ['show-ref', '--verify', '--quiet', full])) !== null;
  if (await exists(`refs/heads/${ref}`)) return 'local';
  if (await exists(`refs/remotes/${ref}`)) return 'remote';
  return 'other';
}

/** The local branch for a remote one: origin/feat/x → feat/x. */
export function localName(remoteRef: string): string {
  return remoteRef.slice(remoteRef.indexOf('/') + 1);
}

/**
 * The worktree that has `branch` checked out, if any (the main one included). One whose
 * folder was deleted is forgotten instead (that one alone, see forgetWorktree), since git
 * would keep the branch taken by it; a locked one (on a disk not mounted now) stays.
 */
export async function worktreeOf(root: string, branch: string): Promise<string | undefined> {
  const holder = (await listWorktrees(root)).find((w) => w.branch === branch);
  if (holder && !holder.locked && (holder.prunable || !fs.existsSync(holder.path))) {
    await forgetWorktree(root, holder.path);
    return undefined;
  }
  return holder?.path;
}

/**
 * Forgets one worktree whose folder is gone: its entry under the repository's
 * .git/worktrees, as `git worktree prune` does for every such worktree. Not prune itself:
 * that would also forget the others whose folders are only out of reach now (a disk not
 * mounted), and nobody asked about those.
 */
export async function forgetWorktree(root: string, dir: string): Promise<void> {
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  const admin = path.join(commonGitDir(gitDir), 'worktrees');
  let ids: string[];
  try {
    ids = fs.readdirSync(admin);
  } catch {
    return;
  }
  const want = path.resolve(dir);
  for (const id of ids) {
    let points: string;
    try {
      points = fs.readFileSync(path.join(admin, id, 'gitdir'), 'utf8').trim();
    } catch {
      continue;
    }
    // gitdir names the worktree's .git file.
    if (path.resolve(path.dirname(points)) === want || samePath(path.dirname(points), want)) {
      fs.rmSync(path.join(admin, id), { recursive: true, force: true });
      return;
    }
  }
}

/** A free sibling folder for a worktree of `ref`: <repo>-<ref>, made safe as a folder name. */
export function siblingDir(root: string, ref: string): string {
  const slug = ref.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const base = path.join(path.dirname(root), `${path.basename(root)}-${slug}`);
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}

/**
 * Checks `ref` out in a worktree of its own and returns its folder: a local branch as itself
 * (reusing the worktree that already has it), a remote branch as a new local branch that
 * tracks it (or the local one of the same name), anything else detached.
 */
export async function addWorktree(root: string, ref: string): Promise<string> {
  const kind = await refKind(root, ref);
  if (kind === 'other') {
    const dir = siblingDir(root, ref);
    await git(root, ['worktree', 'add', '--detach', dir, ref]);
    return dir;
  }
  const branch = kind === 'local' ? ref : localName(ref);
  const existing = await worktreeOf(root, branch);
  if (existing) return existing;
  const dir = siblingDir(root, branch);
  if (kind === 'remote' && (await refKind(root, branch)) !== 'local') {
    await git(root, ['worktree', 'add', '--track', '-b', branch, dir, ref]);
  } else {
    await git(root, ['worktree', 'add', dir, branch]);
  }
  return dir;
}

/**
 * Whether tracked files have uncommitted changes, which switching would carry along (or git
 * refuse to, when they clash). New files never stop a switch, so they do not count.
 */
export async function isDirty(root: string): Promise<boolean> {
  return (await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim() !== '';
}

/** Switches this checkout to `ref`: a branch as itself (a remote one through a local one), anything else detached. */
export async function switchTo(root: string, ref: string): Promise<void> {
  const kind = await refKind(root, ref);
  if (kind === 'local') await git(root, ['switch', ref]);
  else if (kind === 'remote') {
    const branch = localName(ref);
    if ((await refKind(root, branch)) === 'local') await git(root, ['switch', branch]);
    else await git(root, ['switch', '--track', '-c', branch, ref]);
  } else await git(root, ['switch', '--detach', ref]);
}

/** One entry of `git worktree list`. */
export interface WorktreeInfo {
  path: string;
  head?: string;
  /** Short branch name; none when detached. */
  branch?: string;
  /** The repository's own folder (listed first); it cannot be removed as a worktree. */
  main: boolean;
  bare: boolean;
  locked: boolean;
  /** Its folder is gone; `git worktree prune` drops the entry. */
  prunable: boolean;
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(text: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean);
    const first = lines.find((l) => l.startsWith('worktree '));
    if (!first) continue;
    const info: WorktreeInfo = {
      path: first.slice('worktree '.length),
      main: out.length === 0,
      bare: false,
      locked: false,
      prunable: false,
    };
    for (const line of lines) {
      if (line.startsWith('HEAD ')) info.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch '))
        info.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'bare') info.bare = true;
      else if (line === 'locked' || line.startsWith('locked ')) info.locked = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) info.prunable = true;
    }
    out.push(info);
  }
  return out;
}

export async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
  return parseWorktreeList(await git(root, ['worktree', 'list', '--porcelain']));
}

/** What a worktree that Review Desk made was for, kept in the worktree's git dir. */
export interface MadeFor {
  purpose: 'compare' | 'pr';
  ref: string;
  at: string;
}

const MADE_FOR = 'review-desk-worktree.json';

export async function markMadeFor(
  dir: string,
  purpose: MadeFor['purpose'],
  ref: string,
): Promise<void> {
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  const made: MadeFor = { purpose, ref, at: new Date().toISOString() };
  fs.writeFileSync(path.join(gitDir, MADE_FOR), JSON.stringify(made));
}

export function madeFor(gitDir: string): MadeFor | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(gitDir, MADE_FOR), 'utf8')) as MadeFor;
  } catch {
    return undefined;
  }
}

/**
 * Why a worktree cannot be removed without losing something, if so: the main folder, a
 * locked worktree, uncommitted changes or new files (removing the folder would delete them),
 * or commits on a detached HEAD that no branch has. Ignored files (node_modules, build
 * output) do not count: they are made again.
 */
export async function removalProblem(
  repo: string,
  info: WorktreeInfo,
): Promise<string | undefined> {
  if (info.main)
    return "it is the repository's main folder, which git never removes (only the worktrees made from it).";
  if (info.locked)
    return `it is locked (git worktree lock). Unlock it first: git -C "${repo}" worktree unlock "${info.path}"`;
  if (info.prunable || !fs.existsSync(info.path)) return undefined;
  const status = await gitOrNull(info.path, ['status', '--porcelain', '--untracked-files=all']);
  if (status === null) return 'git could not read its status.';
  const changed = status
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3));
  if (changed.length) {
    const shown = changed.slice(0, 3).join(', ') + (changed.length > 3 ? ', …' : '');
    return `it has ${changed.length} uncommitted ${changed.length === 1 ? 'change' : 'changes'} or new ${changed.length === 1 ? 'file' : 'files'} (${shown}), which would be deleted with the folder. Commit, stash or discard ${changed.length === 1 ? 'it' : 'them'} first.`;
  }
  if (!info.branch && info.head) {
    const only = await gitOrNull(info.path, [
      'rev-list',
      '--count',
      'HEAD',
      '--not',
      '--branches',
      '--remotes',
      '--tags',
    ]);
    const n = Number(only?.trim() ?? 0);
    if (n > 0) {
      return `its detached HEAD has ${n} ${n === 1 ? 'commit' : 'commits'} no branch has, which would be hard to find after removing it. Keep ${n === 1 ? 'it' : 'them'} on a branch first: git -C "${info.path}" switch -c <name>`;
    }
  }
  return undefined;
}

/** Ignored names that a build or an install makes again: dependencies, build output, caches. */
const REMADE = new Set([
  'node_modules',
  'bower_components',
  'out',
  'dist',
  'build',
  '.vscode-test',
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.turbo',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
  '.gradle',
  '.DS_Store',
  'Thumbs.db',
]);
const REMADE_FILE = /\.(log|tsbuildinfo|pyc|class|o|vsix)$/;

/**
 * The ignored files and folders of a worktree that no build or install makes again (.env,
 * local settings): removing the worktree deletes them for good. An ignored folder is named,
 * not what is in it.
 */
export async function ignoredToKeep(dir: string): Promise<string[]> {
  const status = await gitOrNull(dir, [
    ...['status', '--porcelain', '-z'],
    // matching: an ignored folder is listed as itself, without going through it.
    ...['--ignored=matching', '--untracked-files=normal'],
  ]);
  return (status ?? '')
    .split('\0')
    .filter((e) => e.startsWith('!! '))
    .map((e) => e.slice(3).replace(/\/$/, ''))
    .filter((p) => !p.split('/').some((part) => REMADE.has(part)) && !REMADE_FILE.test(p));
}

/**
 * How many commits of the local `branch` no remote has (pushed nowhere): only this repository
 * has them. None when the repository has no remote, where nothing is ever pushed.
 */
export async function unpushedCount(repo: string, branch: string): Promise<number | undefined> {
  if (!(await gitOrNull(repo, ['remote']))?.trim()) return undefined;
  const n = await gitOrNull(repo, [
    ...['rev-list', '--count', `refs/heads/${branch}`],
    ...['--not', '--remotes'],
  ]);
  return n === null ? undefined : Number(n.trim());
}

/** Removes a worktree (its folder too), or forgets one whose folder is gone. */
export async function removeWorktree(repo: string, info: WorktreeInfo): Promise<void> {
  if (info.prunable || !fs.existsSync(info.path)) await forgetWorktree(repo, info.path);
  else await git(repo, ['worktree', 'remove', info.path]);
}
