import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordedBase, rememberPrTarget } from '../../src/review/branchBase';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('recordedBase', () => {
  let repo: FixtureRepo;
  let gitDir: string;

  beforeAll(() => {
    repo = fixtureCopy();
    gitDir = path.join(repo.dir, '.git');
  });
  afterAll(() => removeFixture(repo));

  it('has nothing on record for a fresh branch', async () => {
    expect(await recordedBase(repo.dir, gitDir, 'feat/refresh')).toBeUndefined();
  });

  it('falls back to the base of the branch’s last review', async () => {
    const store = path.join(gitDir, 'review-desk');
    fs.mkdirSync(store, { recursive: true });
    const head = repo.git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(
      path.join(store, `${head}.json`),
      JSON.stringify({
        version: 1,
        base: { ref: 'feat/rename', sha: head },
        head: { ref: 'feat/refresh', sha: head },
        annotations: [],
      }),
    );
    expect(await recordedBase(repo.dir, gitDir, 'feat/refresh')).toEqual({
      ref: 'feat/rename',
      source: 'last-review',
    });
  });

  it('prefers the PR target remembered in the git config, shared with gh', async () => {
    await rememberPrTarget(repo.dir, 'feat/refresh', 'main');
    expect(repo.git('config', '--get', 'branch.feat/refresh.gh-merge-base').trim()).toBe('main');
    expect(await recordedBase(repo.dir, gitDir, 'feat/refresh')).toEqual({
      ref: 'main',
      source: 'gh-merge-base',
      detail: 'main',
    });
  });
});
