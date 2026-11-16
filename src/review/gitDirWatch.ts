import * as fs from 'node:fs';
import * as path from 'node:path';
import { commonGitDir } from './store';

/** Files in the git dir that change when HEAD moves: checkout, commit (index), reset. */
const HEAD_FILES = ['HEAD', 'index', 'ORIG_HEAD', 'packed-refs'];

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export interface GitDirEvents {
  /** HEAD may have moved (commit, checkout, reset): check where it is now. */
  headMaybeMoved(): void;
  /** A fetch from elsewhere (a terminal, VS Code's autofetch) wrote FETCH_HEAD. */
  fetched(): void;
  /** The remote branch of the branch checked out moved: a push (a fetch says `fetched` too). */
  remoteMoved?(): void;
}

/**
 * Watches a repository's git dir for HEAD moves and fetches. fs.watch on the git dir hears
 * HEAD change on checkout and most commits rewrite the index; but fs.watch can miss events
 * (macOS FSEvents under load, as right after a window reload) and does not look below the git
 * dir on Linux, while an empty commit may leave the index as it was. So the files'
 * modification times are also checked every `interval`: those above, HEAD's reflog (every
 * move of HEAD adds to it) and the branch's ref (every commit moves it).
 */
export class GitDirWatch {
  private readonly watcher: fs.FSWatcher | undefined;
  private readonly poll: NodeJS.Timeout;
  private readonly common: string;
  private seenHead: string;
  private seenFetch: string;
  private seenRemote: string;
  /** Fetches of Review Desk's own in progress: the FETCH_HEAD they write is not news. */
  private fetching = 0;

  constructor(
    private readonly gitDir: string,
    private readonly on: GitDirEvents,
    interval = 1000,
  ) {
    this.common = commonGitDir(gitDir);
    try {
      this.watcher = fs.watch(gitDir, (_event, filename) => {
        if (filename === null || HEAD_FILES.includes(filename)) on.headMaybeMoved();
      });
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      // The poll below still notices.
    }
    this.seenHead = this.headStamp();
    this.seenFetch = this.fetchStamp();
    this.seenRemote = this.remoteStamp();
    this.poll = setInterval(() => this.check(), interval);
  }

  private headFiles(): string[] {
    const files = [...HEAD_FILES, path.join('logs', 'HEAD')].map((f) => path.join(this.gitDir, f));
    let head = '';
    try {
      head = fs.readFileSync(path.join(this.gitDir, 'HEAD'), 'utf8');
    } catch {
      // Being rewritten: its mtime tells.
    }
    const branch = /^ref: (refs\/\S+)/.exec(head)?.[1];
    if (branch) files.push(path.join(this.common, branch));
    return files;
  }

  private headStamp(): string {
    return this.headFiles().map(mtime).join();
  }

  /** FETCH_HEAD is written in the git dir of the folder a fetch ran in: this one's or the main one's. */
  private fetchStamp(): string {
    return [...new Set([this.gitDir, this.common])]
      .map((d) => mtime(path.join(d, 'FETCH_HEAD')))
      .join();
  }

  /**
   * The branch checked out, as each remote has it (refs/remotes/<remote>/<branch>, and its
   * reflog): a push moves it without a FETCH_HEAD. A packed one moves packed-refs (see HEAD_FILES).
   */
  private remoteStamp(): string {
    let head = '';
    try {
      head = fs.readFileSync(path.join(this.gitDir, 'HEAD'), 'utf8');
    } catch {
      return '';
    }
    const branch = /^ref: refs\/heads\/(\S+)/.exec(head)?.[1];
    if (!branch) return '';
    let remotes: string[] = [];
    try {
      remotes = fs.readdirSync(path.join(this.common, 'refs', 'remotes'));
    } catch {
      return '';
    }
    return remotes
      .flatMap((r) => [
        path.join(this.common, 'refs', 'remotes', r, branch),
        path.join(this.common, 'logs', 'refs', 'remotes', r, branch),
      ])
      .map(mtime)
      .join();
  }

  private check(): void {
    const fetched = this.fetchStamp();
    const remote = this.remoteStamp();
    if (!this.fetching && fetched !== this.seenFetch) {
      this.seenFetch = fetched;
      this.seenRemote = remote;
      this.on.fetched();
    } else if (!this.fetching && remote !== this.seenRemote) {
      this.seenRemote = remote;
      this.on.remoteMoved?.();
    }
    const head = this.headStamp();
    if (head === this.seenHead) return;
    this.seenHead = head;
    this.on.headMaybeMoved();
  }

  /** Runs a fetch of Review Desk's own, whose caller handles what it changed. */
  async ownFetch<T>(task: () => Promise<T>): Promise<T> {
    this.fetching++;
    try {
      return await task();
    } finally {
      this.seenFetch = this.fetchStamp();
      this.seenRemote = this.remoteStamp();
      this.fetching--;
    }
  }

  dispose(): void {
    clearInterval(this.poll);
    this.watcher?.close();
  }
}
