import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncLabel, syncNote, syncOf } from '../../src/review/sync';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('where a branch stands against the remote', () => {
  let repo: FixtureRepo;
  let bare: string;
  let branch: string;
  const commit = (run: (...a: string[]) => string, message: string) =>
    run(
      ...['-c', 'user.name=T', '-c', 'user.email=t@example.com'],
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message,
    );
  const remote = (...args: string[]) =>
    execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();
  const now = async () => {
    const s = await syncOf(repo.dir);
    return [syncLabel(s), syncNote(s)];
  };

  beforeAll(() => {
    repo = fixtureCopy();
    bare = path.join(path.dirname(repo.dir), 'sync.git');
    execFileSync('git', ['clone', '-q', '--bare', repo.dir, bare]);
    repo.git('remote', 'add', 'origin', bare);
    repo.git('fetch', '-q', 'origin');
    branch = repo.git('branch', '--show-current').trim();
    repo.git('branch', '-q', '--set-upstream-to', `origin/${branch}`);
  });
  afterAll(() => removeFixture(repo));

  it('is synced with its upstream, or has commits to push, to pull, or both', async () => {
    expect(await now()).toEqual([
      '',
      `In sync with origin/${branch} (as of the last fetch or push).`,
    ]);

    commit(repo.git, 'here');
    expect(await now()).toEqual([
      '↑1',
      `1 commit to push to origin/${branch} (as of the last fetch or push).`,
    ]);

    const there = remote(
      ...['-c', 'user.name=R', '-c', 'user.email=r@example.com'],
      ...['commit-tree', `${branch}^{tree}`, '-p', branch, '-m', 'there'],
    );
    remote('update-ref', `refs/heads/${branch}`, there);
    repo.git('fetch', '-q', 'origin');
    expect(await now()).toEqual([
      '↑1 ↓1',
      `1 commit to push to origin/${branch}, 1 commit to pull from it (as of the last fetch or push).`,
    ]);

    repo.git('reset', '-q', '--hard', `origin/${branch}`);
    expect((await now())[0]).toBe('');
  });

  it('without a remote branch of its own, counts the commits no remote has', async () => {
    // Made from origin/<branch>, git tracks that: still never pushed under its own name.
    repo.git('switch', '-q', '--track', '-c', 'local-only', `origin/${branch}`);
    expect(await now()).toEqual([
      '',
      'No remote branch of its own; every commit is on a remote already.',
    ]);
    commit(repo.git, 'only here');
    commit(repo.git, 'only here too');
    expect(await now()).toEqual([
      '↑2 not pushed',
      'Not pushed: 2 commits on no remote yet. Push to share them.',
    ]);
    // Detached at it: the same commits.
    repo.git('switch', '-q', '--detach');
    expect((await now())[0]).toBe('↑2 not pushed');
  });

  it('says nothing in a repository with no remote', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-none-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      expect(await syncOf(dir)).toBeUndefined();
      expect([syncLabel(undefined), syncNote(undefined)]).toEqual(['', '']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
