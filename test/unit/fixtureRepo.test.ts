import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureRepo, type FixtureRepo } from '../fixtures/fixtureRepo';

describe('fixture repository', () => {
  let repo: FixtureRepo;

  beforeAll(() => {
    repo = createFixtureRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-fixture-')));
  });
  afterAll(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  it('creates every scenario branch and leaves feat/refresh checked out', () => {
    const branches = repo.git('branch', '--format=%(refname:short)').trim().split('\n').sort();
    expect(branches).toEqual(['feat/big', 'feat/refresh', 'feat/rename', 'main']);
    expect(repo.git('branch', '--show-current').trim()).toBe('feat/refresh');
  });

  it('is deterministic', () => {
    const other = createFixtureRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-fixture-')));
    try {
      expect(other.git('rev-parse', 'feat/refresh')).toBe(repo.git('rev-parse', 'feat/refresh'));
    } finally {
      fs.rmSync(other.dir, { recursive: true, force: true });
    }
  });

  it('has the expected change shapes', () => {
    expect(
      repo.git('diff', '--name-status', 'main', 'feat/refresh').trim().split('\n'),
    ).toHaveLength(4);
    expect(repo.git('diff', '-M', '--name-status', 'main', 'feat/rename')).toMatch(
      /^R\d+\tsrc\/lib\/http\.ts\tsrc\/lib\/httpClient\.ts/m,
    );
    expect(repo.git('diff', '--numstat', 'main', 'feat/big')).toMatch(/^-\t-\tassets\/logo\.png/m);
  });
});
