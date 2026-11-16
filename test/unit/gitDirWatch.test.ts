import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchAll } from '../../src/review/fetch';
import { GitDirWatch } from '../../src/review/gitDirWatch';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('watching the git dir, and fetching', () => {
  let repo: FixtureRepo;
  let bare: string;
  const remote = (...args: string[]) =>
    execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();
  const gitDir = () => repo.git('rev-parse', '--absolute-git-dir').trim();
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    return check();
  };

  beforeAll(() => {
    repo = fixtureCopy();
    bare = path.join(path.dirname(repo.dir), 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', repo.dir, bare]);
    repo.git('remote', 'add', 'upstream', bare);
    repo.git('fetch', '-q', 'upstream');
  });
  afterAll(() => removeFixture(repo));

  it('says what a fetch moved: new, forward, deleted', async () => {
    const next = remote(
      ...['-c', 'user.name=R', '-c', 'user.email=r@example.com'],
      ...['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'on the remote'],
    );
    remote('update-ref', 'refs/heads/main', next);
    remote('update-ref', 'refs/heads/fresh', next);
    remote('update-ref', '-d', 'refs/heads/feat/rename');
    expect((await fetchAll(repo.dir)).sort()).toEqual([
      'upstream/feat/rename deleted',
      'upstream/fresh new',
      'upstream/main +1 commit',
    ]);
    expect(await fetchAll(repo.dir)).toEqual([]);
  });

  it('hears an empty commit, and a fetch from elsewhere but not its own', async () => {
    let moved = 0;
    let fetched = 0;
    const watch = new GitDirWatch(
      gitDir(),
      { headMaybeMoved: () => moved++, fetched: () => fetched++ },
      30,
    );
    try {
      // Past the file system's time resolution, so the new mtimes differ.
      await new Promise((r) => setTimeout(r, 50));
      repo.git('commit', '-q', '--allow-empty', '-m', 'empty');
      expect(await until(() => moved > 0)).toBe(true);

      await watch.ownFetch(() => fetchAll(repo.dir));
      await new Promise((r) => setTimeout(r, 150));
      expect(fetched).toBe(0);

      repo.git('fetch', '-q', 'upstream');
      expect(await until(() => fetched > 0)).toBe(true);
    } finally {
      watch.dispose();
    }
  });

  it('hears a push of the branch checked out, which writes no FETCH_HEAD', async () => {
    let pushed = 0;
    let fetched = 0;
    const watch = new GitDirWatch(
      gitDir(),
      { headMaybeMoved: () => undefined, fetched: () => fetched++, remoteMoved: () => pushed++ },
      30,
    );
    try {
      await new Promise((r) => setTimeout(r, 50));
      repo.git('commit', '-q', '--allow-empty', '-m', 'to push');
      repo.git('push', '-q', 'upstream', repo.git('branch', '--show-current').trim());
      expect(await until(() => pushed > 0)).toBe(true);
      expect(fetched).toBe(0);
    } finally {
      watch.dispose();
    }
  });
});
