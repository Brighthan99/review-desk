import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comparisonHistory } from '../../src/review/history';
import { computeTarget } from '../../src/review/target';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('comparisonHistory', () => {
  let repo: FixtureRepo;

  beforeAll(() => {
    repo = fixtureCopy();
  });
  afterAll(() => removeFixture(repo));

  it('draws HEAD down to the base commit, with branch and tag names', async () => {
    const rows = await comparisonHistory(await computeTarget(repo.dir));
    expect(rows.map((r) => r.kind)).toEqual(['commit', 'base']);
    const [head, base] = rows as Extract<(typeof rows)[number], { sha: string }>[];
    expect(head.subject).toBe('Refresh expired tokens on the server');
    expect(head.refs).toEqual(expect.arrayContaining(['HEAD', 'feat/refresh', 'fixture-refresh']));
    expect(base.sha).toBe(repo.git('rev-parse', 'main').trim());
    expect(base.refs).toContain('main');
  });

  it('puts uncommitted changes on top, and notes a base branch that moved on', async () => {
    repo.git('switch', '-q', 'main');
    repo.git('commit', '-q', '--allow-empty', '-m', 'later on main');
    repo.git('switch', '-q', 'feat/refresh');
    fs.writeFileSync(path.join(repo.dir, 'NOTES.md'), 'draft\n');
    try {
      const rows = await comparisonHistory(
        await computeTarget(repo.dir, 'main', { workTree: true }),
      );
      expect(rows[0]).toEqual({ kind: 'uncommitted', files: 1, added: 1 });
      expect(rows.at(-1)).toEqual({ kind: 'ahead', ref: 'main', count: 1 });
      expect(rows.map((r) => r.kind)).toEqual(['uncommitted', 'commit', 'base', 'ahead']);
    } finally {
      fs.rmSync(path.join(repo.dir, 'NOTES.md'));
      repo.git('switch', '-q', 'main');
      repo.git('reset', '-q', '--hard', 'HEAD~1');
      repo.git('switch', '-q', 'feat/refresh');
    }
  });

  it('shows only the commits it was asked for, and how many more there are', async () => {
    const t = await computeTarget(repo.dir);
    const rows = await comparisonHistory(
      { ...t, base: { ...t.base, sha: repo.git('rev-list', '--max-parents=0', 'HEAD').trim() } },
      0,
    );
    expect(rows[0].kind).toBe('more');
  });

  it('lists a few commits from before the base, to move the base back to', async () => {
    const t = await computeTarget(repo.dir, 'HEAD');
    const rows = await comparisonHistory(t);
    expect(rows.map((r) => r.kind)).toEqual(['base', 'earlier']);
    const earlier = rows[1] as Extract<(typeof rows)[number], { sha: string }>;
    expect(earlier.sha).toBe(repo.git('rev-parse', 'HEAD~1').trim());
    expect((await comparisonHistory(t, 15, 0)).map((r) => r.kind)).toEqual(['base']);
  });
});
