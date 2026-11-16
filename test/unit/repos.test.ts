import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickRepo, readRepo, readRepos, repoOf } from '../../src/review/repos';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('the repositories open in the window', () => {
  let repo: FixtureRepo;
  let parent: string;
  let empty: string;
  let plain: string;

  beforeAll(() => {
    repo = fixtureCopy();
    parent = fs.mkdtempSync(path.join(path.dirname(repo.dir), 'repos-'));
    empty = path.join(parent, 'empty');
    plain = path.join(parent, 'plain');
    fs.mkdirSync(plain);
    repo.git('init', '-q', '--initial-branch=trunk', empty);
  });
  afterAll(() => {
    fs.rmSync(parent, { recursive: true, force: true });
    removeFixture(repo);
  });

  it("reads a folder's repository: its branch and commit, a new one's branch, none outside", async () => {
    const real = fs.realpathSync(repo.dir);
    expect(await readRepo(path.join(repo.dir, 'src'))).toEqual({
      root: real,
      gitDir: path.join(real, '.git'),
      branch: 'feat/refresh',
      sha: repo.git('rev-parse', 'HEAD').trim(),
      worktree: false,
    });
    expect(await readRepo(empty)).toMatchObject({ branch: 'trunk', sha: undefined });
    expect(await readRepo(plain)).toBeUndefined();

    repo.git('switch', '-q', '--detach', 'main');
    try {
      const sha = repo.git('rev-parse', 'HEAD').trim();
      expect((await readRepo(repo.dir))?.branch).toBe(`detached ${sha.slice(0, 7)}`);
    } finally {
      repo.git('switch', '-q', 'feat/refresh');
    }
  });

  it("tells a git worktree from a repository's own folder", async () => {
    const wt = path.join(parent, 'wt');
    repo.git('worktree', 'add', '-q', '--detach', wt, 'main');
    try {
      expect(await readRepo(wt)).toMatchObject({ root: fs.realpathSync(wt), worktree: true });
      expect((await readRepo(repo.dir))?.worktree).toBe(false);
    } finally {
      repo.git('worktree', 'remove', '--force', wt);
    }
  });

  it('starts a review in the first likely folder with a commit, else says why the first cannot', async () => {
    // Two folders of one repository count once; a folder with no repository not at all.
    const repos = await readRepos([empty, plain, repo.dir, path.join(repo.dir, 'src')]);
    expect(repos.map((r) => path.basename(r.root))).toEqual([
      'empty',
      path.basename(fs.realpathSync(repo.dir)),
    ]);
    expect(repoOf(repos, path.join(repo.dir, 'src', 'auth'))?.root).toBe(fs.realpathSync(repo.dir));
    expect(pickRepo(repos, [empty, plain, repo.dir])?.root).toBe(fs.realpathSync(repo.dir));
    expect(pickRepo(repos, [plain, empty])?.root).toBe(fs.realpathSync(empty));
    expect(pickRepo(repos, [plain])).toBeUndefined();
  });
});
