import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchCommit, branchRefs, commitLabel, recentCommits } from '../../src/review/refList';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('the branches and commits to compare with', () => {
  let repo: FixtureRepo;

  beforeAll(() => {
    repo = fixtureCopy();
    // A remote branch, and the remote's HEAD pointing to it (a symbolic ref).
    repo.git('update-ref', 'refs/remotes/origin/main', 'main');
    repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  });
  afterAll(() => removeFixture(repo));

  it('gives each branch its commit, and leaves out the remote HEAD', async () => {
    const branches = await branchRefs(repo.dir);
    expect(branches.map((b) => b.name)).toEqual([
      'feat/big',
      'feat/refresh',
      'feat/rename',
      'main',
      'origin/main',
    ]);
    const main = branches.find((b) => b.name === 'main')!;
    expect(main.short).toBe(repo.git('rev-parse', '--short', 'main').trim());
    expect(branchCommit(main)).toBe(
      `${main.short} ${repo.git('log', '-1', '--format=%s', 'main').trim()}`,
    );
    expect(branches.filter((b) => b.checkedOut).map((b) => b.name)).toEqual(['feat/refresh']);
  });

  it('labels the recent commits with the branches and tags on them', async () => {
    const [head, base] = await recentCommits(repo.dir);
    expect(head.subject).toBe('Refresh expired tokens on the server');
    expect(commitLabel(head)).toBe(`${head.short} (HEAD, feat/refresh, fixture-refresh)`);
    // In git's order, as `git log --decorate` shows them.
    expect([...base.refs].sort()).toEqual(['main', 'origin/main']);
    expect(commitLabel(base)).toBe(`${base.short} (${base.refs.join(', ')})`);
    expect(base.sha).toBe(repo.git('rev-parse', 'main').trim());
  });
});
