import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`);
  }
}

let gitPath = 'git';

/** Where git commands that failed (`debug`) or took long (`info`) are logged; none by default. */
let gitLog: ((level: 'debug' | 'info', line: string) => void) | undefined;

/** git commands slower than this are logged: a slow repository, a hung credential helper. */
const SLOW_MS = 2000;

/** Sets where git commands that failed or were slow are logged (the extension's log). */
export function setGitLog(log: typeof gitLog): void {
  gitLog = log;
}

/** Sets the git executable used from now on (default: `git` on PATH). */
export function setGitPath(path: string): void {
  gitPath = path;
}

// Runs git with settings that keep output stable regardless of user config; `input`, if
// given, is written to its standard input. Without optional locks: a `git status` would
// otherwise refresh .git/index as a side effect, holding index.lock while the reviewer's own
// `git commit` may need it (Review Desk runs git at every save).
export function git(cwd: string, args: string[], input?: string): Promise<string> {
  const fullArgs = [
    '--no-optional-locks',
    '-c',
    'core.quotePath=false',
    '-c',
    'color.ui=false',
    // A user's color.diff=always (or status, branch…) wins over color.ui: the output would be
    // read with color codes in it (a diff of no files).
    ...['-c', 'color.diff=false', '-c', 'color.status=false', '-c', 'color.branch=false'],
    ...['-c', 'color.grep=false', '-c', 'color.showBranch=false'],
    ...args,
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = execFile(
      gitPath,
      fullArgs,
      { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const ms = Date.now() - started;
        if (ms > SLOW_MS) gitLog?.('info', `git ${args.join(' ')} took ${ms} ms (in ${cwd})`);
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          // Often expected (gitOrNull asks whether a ref exists): only at the Debug level.
          gitLog?.(
            'debug',
            `git ${args.join(' ')} failed (${code ?? error.message}, in ${cwd}): ${stderr.trim()}`,
          );
          reject(new GitError(args, stderr, code));
        } else {
          resolve(stdout);
        }
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

// Like git() but returns null instead of throwing when the command fails.
export async function gitOrNull(
  cwd: string,
  args: string[],
  input?: string,
): Promise<string | null> {
  try {
    return await git(cwd, args, input);
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}
