import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { git } from '../../src/review/git';
import { allIgnored } from '../../src/review/ignored';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('changes git ignores', () => {
  let repo: FixtureRepo;
  const at = (p: string) => path.join(repo.dir, p);

  beforeAll(() => {
    repo = fixtureCopy();
    fs.writeFileSync(at('.gitignore'), 'build/\n*.log\n');
    fs.mkdirSync(at('build'));
    fs.writeFileSync(at('build/out.js'), '');
    fs.writeFileSync(at('kept.log'), '');
    repo.git('add', '-f', 'kept.log');
  });
  afterAll(() => removeFixture(repo));

  it('tells when every changed path is ignored', async () => {
    expect(await allIgnored(repo.dir, [at('build/out.js'), at('debug.log'), at('build')])).toBe(
      true,
    );
  });

  it('counts a change to a file that is not ignored, new or tracked', async () => {
    expect(await allIgnored(repo.dir, [at('build/out.js'), at('src/index.ts')])).toBe(false);
    expect(await allIgnored(repo.dir, [at('notes.txt')])).toBe(false);
    // Tracked although the patterns match it.
    expect(await allIgnored(repo.dir, [at('kept.log')])).toBe(false);
    // The root itself, or outside the repository.
    expect(await allIgnored(repo.dir, [repo.dir])).toBe(false);
    expect(await allIgnored(repo.dir, [path.dirname(repo.dir)])).toBe(false);
  });

  it('passes input to git on its standard input', async () => {
    // A blob's name is the SHA-1 of "blob <size>\0<content>".
    const expected = createHash('sha1').update('blob 2\0x\n').digest('hex');
    expect(await git(repo.dir, ['hash-object', '--stdin'], 'x\n')).toBe(`${expected}\n`);
  });
});
