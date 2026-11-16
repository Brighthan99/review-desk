import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteMergedBranch,
  homeBranch,
  mergedInto,
  updateHome,
} from '../../src/review/homeBranch';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('the branch a finished review goes back to', () => {
  let repo: FixtureRepo;
  let bare: string;
  const remote = (...args: string[]) =>
    execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();
  const commitOn = (cwd: (...a: string[]) => string, ref: string, message: string) => {
    const sha = cwd(
      ...['-c', 'user.name=T', '-c', 'user.email=t@example.com'],
      ...['commit-tree', `${ref}^{tree}`, '-p', ref, '-m', message],
    ).trim();
    cwd('update-ref', `refs/heads/${ref}`, sha);
    return sha;
  };

  beforeAll(() => {
    repo = fixtureCopy();
    bare = path.join(path.dirname(repo.dir), 'home.git');
  });
  afterAll(() => removeFixture(repo));

  it('is main without a remote, then what the remote HEAD names', async () => {
    expect(await homeBranch(repo.dir)).toEqual({ branch: 'main' });
    execFileSync('git', ['clone', '-q', '--bare', repo.dir, bare]);
    repo.git('remote', 'add', 'origin', bare);
    repo.git('fetch', '-q', 'origin');
    repo.git('remote', 'set-head', 'origin', 'main');
    expect(await homeBranch(repo.dir)).toEqual({ branch: 'main', remote: 'origin' });
  });

  it('moves main forward to the remote, unless it has commits of its own', async () => {
    const home = { branch: 'main', remote: 'origin' };
    const ahead = commitOn(remote, 'main', 'on the remote');
    expect(await updateHome(repo.dir, home)).toBe(true);
    expect(repo.git('rev-parse', 'main').trim()).toBe(ahead);

    commitOn(remote, 'main', 'remote again');
    commitOn(repo.git, 'main', 'local only');
    expect(await updateHome(repo.dir, home)).toBe(false);
  });

  it('tells a branch whose commits are all in another', async () => {
    repo.git('branch', '-f', 'done', 'main~1');
    expect(await mergedInto(repo.dir, 'done', 'main')).toBe(true);
    expect(await mergedInto(repo.dir, 'feat/rename', 'main')).toBe(false);
  });

  it('deletes a merged branch even when HEAD lags behind where it was merged, and nothing else', async () => {
    // HEAD lacks the remote's newest commit, which the branch has, and the branch tracks nothing
    // (as pr/<n>): git branch -d refuses it.
    repo.git('switch', '-q', '--detach', 'main');
    repo.git('branch', '-f', '--no-track', 'merged-there', 'origin/main');
    repo.git('config', 'branch.merged-there.review-desk-pr-head', 'x');
    expect(() => repo.git('branch', '-d', 'merged-there')).toThrow(/not fully merged/);
    await deleteMergedBranch(repo.dir, 'merged-there', 'origin/main');
    expect(repo.git('branch', '--list', 'merged-there').trim()).toBe('');
    expect(repo.git('config', '--list', '--local')).not.toContain('branch.merged-there.');
  });

  it('never deletes the branch the others are merged into', async () => {
    await expect(deleteMergedBranch(repo.dir, 'main', 'origin/main')).rejects.toThrow(
      /the branch the others are merged into/,
    );
    await expect(deleteMergedBranch(repo.dir, 'main', 'main')).rejects.toThrow(/merged into/);
    expect(repo.git('branch', '--list', 'main').trim()).not.toBe('');
  });

  it('refuses a branch with commits found nowhere else, and one checked out', async () => {
    await expect(deleteMergedBranch(repo.dir, 'feat/rename', 'main')).rejects.toThrow(
      /feat\/rename has \d+ commits? main does not/,
    );
    expect(repo.git('branch', '--list', 'feat/rename').trim()).not.toBe('');

    repo.git('branch', '-f', 'held', 'origin/main');
    const dir = `${repo.dir}-held`;
    repo.git('worktree', 'add', '-q', dir, 'held');
    await expect(deleteMergedBranch(repo.dir, 'held', 'origin/main')).rejects.toThrow(
      /held is checked out in/,
    );
    repo.git('worktree', 'remove', dir);
  });
});
