import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fetchPullRequest,
  githubRemote,
  keepName,
  movePullBranch,
} from '../../src/github/checkout';
import { addWorktree, worktreeOf } from '../../src/review/worktree';
import type { PullRequest } from '../../src/github/client';
import { computeTarget } from '../../src/review/target';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

const pr = (number: number, sha: string): PullRequest => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/acme/app/pull/${number}`,
  user: { login: 'octocat' },
  head: { ref: `feature-${number}`, sha },
  base: { ref: 'main', sha: '' },
});

describe('PR checkout', () => {
  let repo: FixtureRepo;
  let bare: string;

  beforeAll(() => {
    repo = fixtureCopy();
    bare = path.join(path.dirname(repo.dir), 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', repo.dir, bare]);
    execFileSync(
      'git',
      ['update-ref', 'refs/pull/7/head', repo.git('rev-parse', 'feat/refresh').trim()],
      { cwd: bare },
    );
    execFileSync(
      'git',
      ['update-ref', 'refs/pull/8/head', repo.git('rev-parse', 'feat/rename').trim()],
      { cwd: bare },
    );
    repo.git('remote', 'add', 'origin', bare);
    repo.git('remote', 'add', 'upstream', 'git@github.com:acme/app.git');
    repo.git('switch', '-q', 'main');
  });
  afterAll(() => removeFixture(repo));

  it('finds the GitHub remote', async () => {
    expect(await githubRemote(repo.dir)).toEqual({
      name: 'upstream',
      repo: { host: 'github.com', owner: 'acme', repo: 'app' },
    });
  });

  it('skips a remote on a host that is not GitHub', async () => {
    repo.git('remote', 'add', 'gitlab', 'https://gitlab.com/acme/app.git');
    try {
      const onlyGithub = (host: string) => host === 'github.com';
      expect((await githubRemote(repo.dir, onlyGithub))?.name).toBe('upstream');
      expect(await githubRemote(repo.dir, () => false)).toBeUndefined();
    } finally {
      repo.git('remote', 'remove', 'gitlab');
    }
  });

  /** Fetches a pull request and moves pr/<n> to its head, as opening it does when nothing is asked. */
  const fetchAndMove = async (p: PullRequest) => {
    const { base, update } = await fetchPullRequest(repo.dir, 'origin', p);
    expect(update.own).toBe(0);
    await movePullBranch(repo.dir, update);
    return base;
  };
  const commitOn = (cwd: string, message: string) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message],
      { cwd },
    );
  const sha = (ref: string, cwd = repo.dir) =>
    execFileSync('git', ['rev-parse', ref], { cwd, encoding: 'utf8' }).trim();

  it('fetches the PR head into pr/<n> and the base into <remote>/<base>', async () => {
    const head = sha('feat/refresh');
    const base = await fetchAndMove(pr(7, head));
    expect(base).toBe('origin/main');
    expect(sha('pr/7')).toBe(head);
    repo.git('switch', '-q', 'pr/7');
    const t = await computeTarget(repo.dir, base);
    expect(t.files).toHaveLength(4);
    // Fetching again while on the branch moves it instead of failing.
    await fetchAndMove(pr(7, head));
    expect(sha('HEAD')).toBe(head);
  });

  it('opens a worktree for a PR, and reuses the one that has the branch', async () => {
    await fetchAndMove(pr(8, ''));
    const dir = await addWorktree(repo.dir, 'pr/8');
    expect(dir).toBe(`${repo.dir}-pr-8`);
    expect(fs.existsSync(path.join(dir, 'src/lib/httpClient.ts'))).toBe(true);
    expect(fs.realpathSync(await addWorktree(repo.dir, 'pr/8'))).toBe(fs.realpathSync(dir));
    // New commits on the PR: fetching again moves the worktree that has the branch.
    const newer = sha('feat/refresh');
    execFileSync('git', ['update-ref', 'refs/pull/8/head', newer], { cwd: bare });
    await fetchAndMove(pr(8, ''));
    expect(sha('HEAD', dir)).toBe(newer);
    expect(fs.realpathSync((await worktreeOf(repo.dir, 'pr/7'))!)).toBe(fs.realpathSync(repo.dir));
    repo.git('worktree', 'remove', '--force', dir);
  });

  it('counts commits made on pr/<n>, and keeps them on another branch when moving it', async () => {
    // pr/7 is checked out here (the first test): a commit made on it.
    commitOn(repo.dir, 'made on pr/7');
    const mine = sha('pr/7');
    const { update } = await fetchPullRequest(repo.dir, 'origin', pr(7, ''));
    expect(update).toMatchObject({ branch: 'pr/7', current: mine, own: 1 });
    expect(fs.realpathSync(update.holder!)).toBe(fs.realpathSync(repo.dir));
    const keepAs = await keepName(repo.dir, 'pr/7');
    expect(keepAs).toBe('pr/7-before');
    await movePullBranch(repo.dir, update, keepAs);
    expect(sha('HEAD')).toBe(update.head);
    expect(sha('pr/7-before')).toBe(mine);
    expect(await keepName(repo.dir, 'pr/7')).toBe('pr/7-before-2');
  });

  it('does not count the commits of a head the pull request no longer has (force-pushed)', async () => {
    // Rewritten: the head becomes a commit beside the old one, not after it.
    const old = sha('pr/7');
    const rewritten = execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit-tree',
        `${old}^{tree}`,
        '-p',
        `${old}~1`,
        '-m',
        'rewritten',
      ],
      { cwd: repo.dir, encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['push', '-q', bare, `${rewritten}:refs/pull/7/head`, '-f'], {
      cwd: repo.dir,
    });
    const { update } = await fetchPullRequest(repo.dir, 'origin', pr(7, ''));
    expect(update).toMatchObject({ current: old, head: rewritten, own: 0 });
    await movePullBranch(repo.dir, update);
    expect(sha('HEAD')).toBe(rewritten);
  });

  it('counts the commits of a branch of the same name it did not make', async () => {
    repo.git('switch', '-q', 'main');
    repo.git('branch', '-f', 'pr/9', 'feat/rename');
    execFileSync('git', ['update-ref', 'refs/pull/9/head', sha('feat/refresh')], { cwd: bare });
    const { update } = await fetchPullRequest(repo.dir, 'origin', pr(9, ''));
    expect(update.holder).toBeUndefined();
    expect(update.own).toBeGreaterThan(0);
  });

  it('drops the branch it kept the commits on when pr/<n> could not move', async () => {
    // pr/7, checked out here, back at main with an uncommitted edit to a file the PR head
    // changes: git stops instead of moving it.
    repo.git('switch', '-q', 'pr/7');
    const { update } = await fetchPullRequest(repo.dir, 'origin', pr(7, ''));
    expect(update.holder).toBeDefined();
    repo.git('reset', '-q', '--hard', 'main');
    const changed = repo
      .git('diff', '--name-only', '--diff-filter=M', 'main', update.head)
      .split('\n')[0];
    fs.appendFileSync(path.join(repo.dir, changed), '\n// uncommitted\n');
    const back = { ...update, current: sha('pr/7'), own: 1 };
    await expect(movePullBranch(repo.dir, back, 'pr/7-kept')).rejects.toThrow();
    expect(repo.git('branch', '--list', 'pr/7-kept').trim()).toBe('');
    expect(sha('pr/7')).toBe(sha('main'));
    repo.git('checkout', '-q', '--', changed);
    repo.git('switch', '-q', 'main');
  });

  it('refuses to move pr/<n> when it moved since it was looked at', async () => {
    const { update } = await fetchPullRequest(repo.dir, 'origin', pr(9, ''));
    repo.git('branch', '-f', 'pr/9', 'main');
    await expect(movePullBranch(repo.dir, update, 'pr/9-before')).rejects.toThrow(
      /changed meanwhile/,
    );
    expect(sha('pr/9')).toBe(sha('main'));
    expect(await keepName(repo.dir, 'pr/9')).toBe('pr/9-before');
  });
});
