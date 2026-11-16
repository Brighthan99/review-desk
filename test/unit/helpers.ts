import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inject } from 'vitest';
import { copyFixtureRepo, type FixtureRepo } from '../fixtures/fixtureRepo';

export function fixtureCopy(): FixtureRepo {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-test-')), 'repo');
  return copyFixtureRepo(inject('fixtureTemplate'), dir);
}

export function removeFixture(repo: FixtureRepo): void {
  fs.rmSync(path.dirname(repo.dir), { recursive: true, force: true });
}
