import * as path from 'node:path';
import { gitOrNull } from './git';
import { realpath } from './realpath';
import { isLinkedWorktree } from './store';

/** A git repository open in the window: where a review can start. */
export interface Repo {
  /** Its top folder, as git gives it (symlinks resolved). */
  root: string;
  gitDir: string;
  /** The branch checked out (a new repository's too), or `detached 1a2b3c4`. */
  branch: string;
  /** The commit HEAD is on; none in a new repository, which has nothing to review yet. */
  sha?: string;
  /** A git worktree made from another folder's repository, not a repository's own folder. */
  worktree: boolean;
}

/** The repository `folder` is in, or undefined when it is in none. */
export async function readRepo(folder: string): Promise<Repo | undefined> {
  const out = await gitOrNull(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  if (!out) return undefined;
  const [root, gitDir] = out.trim().split('\n');
  if (!root || !gitDir) return undefined;
  const sha =
    (await gitOrNull(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() ||
    undefined;
  const branch = (await gitOrNull(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim();
  return {
    root,
    gitDir,
    sha,
    branch: branch || `detached ${sha?.slice(0, 7) ?? 'HEAD'}`,
    worktree: isLinkedWorktree(gitDir),
  };
}

/** The repositories of `folders`, each once, in their order. */
export async function readRepos(folders: string[]): Promise<Repo[]> {
  const repos = await Promise.all(folders.map(readRepo));
  const seen = new Set<string>();
  return repos.filter((r): r is Repo => !!r && !seen.has(r.root) && !!seen.add(r.root));
}

/** The repository among `repos` that holds `folder`. */
export function repoOf(repos: Repo[], folder: string): Repo | undefined {
  const real = realpath(folder);
  return repos.find((r) => real === r.root || real.startsWith(r.root + path.sep));
}

/**
 * Where a review starts: the repository of the first of `candidates` (most likely first)
 * that has a commit, else of the first (which then says why it can't be reviewed). In a
 * multi-root workspace the first folder may be a new repository, or no repository at all.
 */
export function pickRepo(repos: Repo[], candidates: string[]): Repo | undefined {
  const held = candidates.map((c) => repoOf(repos, c)).filter((r): r is Repo => !!r);
  return held.find((r) => r.sha) ?? held[0];
}
