import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewStore } from '../../src/review/store';
import {
  addWorktree,
  listWorktrees,
  parseWorktreeList,
  refKind,
  ignoredToKeep,
  removalProblem,
  worktreeOf,
  removeWorktree,
  siblingDir,
  switchTo,
  unpushedCount,
} from '../../src/review/worktree';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('worktrees for the right side', () => {
  let repo: FixtureRepo;
  let clone: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeAll(() => {
    repo = fixtureCopy();
    // A clone, so the fixture's branches are remote branches (origin/...).
    clone = path.join(path.dirname(repo.dir), 'clone');
    git(path.dirname(repo.dir), 'clone', '-q', repo.dir, clone);
  });
  afterAll(() => removeFixture(repo));

  it('tells local branches, remote branches and other refs apart', async () => {
    expect(await refKind(repo.dir, 'feat/rename')).toBe('local');
    expect(await refKind(clone, 'origin/feat/rename')).toBe('remote');
    expect(await refKind(repo.dir, 'fixture-refresh')).toBe('other');
    expect(await refKind(repo.dir, git(repo.dir, 'rev-parse', 'main'))).toBe('other');
  });

  it('names a free sibling folder after the ref', () => {
    expect(siblingDir(repo.dir, 'feat/x y')).toBe(`${repo.dir}-feat-x-y`);
    fs.mkdirSync(`${repo.dir}-taken`);
    expect(siblingDir(repo.dir, 'taken')).toBe(`${repo.dir}-taken-2`);
  });

  it('checks out a local branch, reusing a worktree that has it', async () => {
    const dir = await addWorktree(repo.dir, 'feat/rename');
    expect(git(dir, 'branch', '--show-current')).toBe('feat/rename');
    // git lists worktrees with symlinks resolved (/private/var on macOS).
    expect(fs.realpathSync(await addWorktree(repo.dir, 'feat/rename'))).toBe(fs.realpathSync(dir));
  });

  it('forgets a worktree whose folder was deleted, freeing its branch', async () => {
    git(repo.dir, 'branch', 'gone', 'main');
    const dir = await addWorktree(repo.dir, 'gone');
    expect(fs.realpathSync((await worktreeOf(repo.dir, 'gone'))!)).toBe(fs.realpathSync(dir));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(await worktreeOf(repo.dir, 'gone')).toBeUndefined();
    expect((await listWorktrees(repo.dir)).some((w) => w.branch === 'gone')).toBe(false);
    git(repo.dir, 'branch', '-D', 'gone'); // git refuses while a worktree has it.
  });

  it('checks out a remote branch as a local branch that tracks it', async () => {
    const dir = await addWorktree(clone, 'origin/feat/big');
    expect(git(dir, 'branch', '--show-current')).toBe('feat/big');
    expect(git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feat/big');
  });

  it('checks out a commit detached', async () => {
    const sha = git(repo.dir, 'rev-parse', 'main');
    const dir = await addWorktree(repo.dir, sha);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(dir, 'branch', '--show-current')).toBe('');
  });

  it('switches this checkout to a remote branch through a local one', async () => {
    await switchTo(clone, 'origin/feat/rename');
    expect(git(clone, 'branch', '--show-current')).toBe('feat/rename');
    expect(git(clone, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feat/rename');
  });

  it('reads git worktree list --porcelain', () => {
    const list = parseWorktreeList(
      [
        'worktree /r/main',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /r/main-feat-x',
        'HEAD bbb',
        'branch refs/heads/feat/x',
        'locked',
        '',
        'worktree /r/main-abc1234',
        'HEAD ccc',
        'detached',
        '',
        'worktree /r/gone',
        'HEAD ddd',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    );
    expect(list.map((w) => [w.path, w.branch, w.main, w.locked, w.prunable])).toEqual([
      ['/r/main', 'main', true, false, false],
      ['/r/main-feat-x', 'feat/x', false, true, false],
      ['/r/main-abc1234', undefined, false, false, false],
      ['/r/gone', undefined, false, false, true],
    ]);
  });

  it('counts the commits of a branch no remote has, and none without a remote', async () => {
    // The clone's branch is its remote's: all pushed.
    const cloned = git(clone, 'branch', '--show-current');
    expect(await unpushedCount(clone, cloned)).toBe(0);
    git(clone, 'switch', '-q', '-c', 'local-only');
    git(
      clone,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'here only',
    );
    try {
      expect(await unpushedCount(clone, 'local-only')).toBe(1);
    } finally {
      git(clone, 'switch', '-q', cloned);
    }
    // A repository with no remote pushes nowhere: nothing to tell.
    expect(await unpushedCount(repo.dir, 'main')).toBeUndefined();
  });
});

describe('removing a worktree', () => {
  let repo: FixtureRepo;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const info = async (dir: string) =>
    (await listWorktrees(repo.dir)).find((w) => fs.realpathSync(w.path) === fs.realpathSync(dir))!;

  beforeAll(() => {
    repo = fixtureCopy();
  });
  afterAll(() => removeFixture(repo));

  it('says why it cannot: the main folder, uncommitted work, commits only it has, a lock', async () => {
    const [main] = await listWorktrees(repo.dir);
    expect(await removalProblem(repo.dir, main)).toMatch(/main folder/);

    const dir = `${repo.dir}-wt`;
    git(repo.dir, 'worktree', 'add', '-q', dir, 'feat/rename');
    expect(await removalProblem(repo.dir, await info(dir))).toBeUndefined();

    fs.writeFileSync(path.join(dir, 'new.txt'), 'draft');
    expect(await removalProblem(repo.dir, await info(dir))).toMatch(
      /1 uncommitted change or new file \(new\.txt\)/,
    );
    fs.rmSync(path.join(dir, 'new.txt'));

    git(dir, 'switch', '-q', '--detach');
    git(
      dir,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'only here',
    );
    expect(await removalProblem(repo.dir, await info(dir))).toMatch(/1 commit no branch has/);
    git(dir, 'switch', '-q', 'feat/rename');

    git(repo.dir, 'worktree', 'lock', dir);
    expect(await removalProblem(repo.dir, await info(dir))).toMatch(/locked/);
    git(repo.dir, 'worktree', 'unlock', dir);
  });

  it('forgets only the worktree removed whose folder is gone, not others out of reach now', async () => {
    const gone = `${repo.dir}-gone`;
    const away = `${repo.dir}-away`;
    git(repo.dir, 'worktree', 'add', '-q', '--detach', gone);
    git(repo.dir, 'worktree', 'add', '-q', '--detach', away);
    fs.rmSync(gone, { recursive: true, force: true });
    // On a disk not mounted now: its folder is not there for a while.
    fs.renameSync(away, `${away}-unmounted`);
    try {
      // Its folder is gone: found by name (its path no longer resolves).
      const entry = (await listWorktrees(repo.dir)).find(
        (w) => path.basename(w.path) === path.basename(gone),
      )!;
      expect(entry.prunable).toBe(true);
      await removeWorktree(repo.dir, entry);
      const left = (await listWorktrees(repo.dir)).map((w) => path.basename(w.path));
      expect(left).not.toContain(path.basename(gone));
      expect(left).toContain(path.basename(away));
    } finally {
      fs.renameSync(`${away}-unmounted`, away);
      git(repo.dir, 'worktree', 'remove', '--force', away);
    }
  });

  it('names the ignored files it would delete that no build or install makes again', async () => {
    const dir = `${repo.dir}-wt`;
    expect(await ignoredToKeep(dir)).toEqual([]);
    const exclude = git(dir, 'rev-parse', '--git-path', 'info/exclude');
    const before = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, `${before}\nnode_modules/\nout/\n*.log\n.env\nlocal settings/\n`);
    try {
      for (const f of [
        'node_modules/a/x.js',
        'out/y.js',
        'debug.log',
        '.env',
        'local settings/k',
        'sub/.env',
      ]) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), '');
      }
      expect(await ignoredToKeep(dir)).toEqual(['.env', 'local settings', 'sub/.env']);
    } finally {
      fs.writeFileSync(exclude, before);
      for (const f of ['node_modules', 'out', 'debug.log', '.env', 'local settings', 'sub']) {
        fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      }
    }
  });

  it('removes it, keeping its branch and the reviews written in it', async () => {
    const dir = `${repo.dir}-wt`;
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir');
    const head = { ref: 'feat/rename', sha: git(dir, 'rev-parse', 'HEAD') };
    const store = new ReviewStore(gitDir);
    store.save({
      version: 1,
      base: { ref: 'main', sha: git(repo.dir, 'rev-parse', 'main') },
      head,
      status: 'done',
      annotations: [],
    });
    // Kept with the repository's other reviews, not in the worktree's own git dir.
    expect(fs.realpathSync(store.dir)).toBe(
      fs.realpathSync(path.join(repo.dir, '.git', 'review-desk')),
    );

    await removeWorktree(repo.dir, await info(dir));
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(repo.dir, 'rev-parse', 'feat/rename')).toBe(head.sha);
    expect(new ReviewStore(path.join(repo.dir, '.git')).load(head.sha).kind).toBe('ok');
  });
});
