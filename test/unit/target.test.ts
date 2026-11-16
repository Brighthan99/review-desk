import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filePath } from '../../src/review/diffParser';
import { setGitPath } from '../../src/review/git';
import { computeTarget, defaultBaseRef, readSide, TargetError } from '../../src/review/target';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('computeTarget', () => {
  let repo: FixtureRepo;

  beforeAll(() => {
    repo = fixtureCopy();
  });
  afterAll(() => removeFixture(repo));

  it('defaults the base to main', async () => {
    expect(await defaultBaseRef(repo.dir)).toBe('main');
  });

  it('reviews feat/refresh against main', async () => {
    const t = await computeTarget(path.join(repo.dir, 'src'));
    expect(t.root).toBe(fs.realpathSync(repo.dir));
    expect(t.gitDir).toBe(path.join(fs.realpathSync(repo.dir), '.git'));
    expect(t.base.ref).toBe('main');
    expect(t.base.sha).toBe(repo.git('rev-parse', 'main').trim());
    expect(t.head).toEqual({ ref: 'feat/refresh', sha: repo.git('rev-parse', 'HEAD').trim() });
    expect(t.files.map(filePath).sort()).toEqual([
      'src/auth/refresh.ts',
      'src/auth/session.ts',
      'src/lib/api-client.ts',
      'test/auth/session.test.ts',
    ]);
    const session = t.files.find((f) => filePath(f) === 'src/auth/session.ts')!;
    const added = session.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add');
    expect(added.find((l) => l.text === '  if (isExpired(token)) {')?.newLine).toBe(8);
  });

  it('detects renames, binary files and missing trailing newlines', async () => {
    repo.git('switch', '-q', 'feat/rename');
    try {
      const t = await computeTarget(repo.dir);
      const f = t.files.find((x) => x.status === 'renamed');
      expect(f).toMatchObject({ oldPath: 'src/lib/http.ts', newPath: 'src/lib/httpClient.ts' });
      repo.git('switch', '-q', 'feat/big');
      const big = await computeTarget(repo.dir);
      expect(big.files.find((x) => x.newPath === 'assets/logo.png')?.binary).toBe(true);
      expect(big.files.find((x) => x.newPath === 'src/generated/values.ts')?.additions).toBe(600);
      const readme = big.files.find((x) => x.newPath === 'README.md')!;
      expect(readme.hunks.flatMap((h) => h.lines).some((l) => l.noNewlineAtEnd)).toBe(true);
    } finally {
      repo.git('switch', '-q', 'feat/refresh');
    }
  });

  it('opens a review with no changes, and refuses one without a base', async () => {
    repo.git('switch', '-q', 'main');
    try {
      expect((await computeTarget(repo.dir)).files).toEqual([]);
      await expect(computeTarget(repo.dir, 'no-such-branch')).rejects.toThrow();
      repo.git('branch', '-m', 'main', 'trunk');
      await expect(computeTarget(repo.dir)).rejects.toBeInstanceOf(TargetError);
    } finally {
      repo.git('branch', '-m', 'trunk', 'main');
      repo.git('switch', '-q', 'feat/refresh');
    }
  });

  it('says why a folder with no commits, or no repository, cannot be reviewed', async () => {
    const parent = fs.mkdtempSync(path.join(path.dirname(repo.dir), 'start-'));
    const empty = path.join(parent, 'empty');
    const plain = path.join(parent, 'plain');
    fs.mkdirSync(plain);
    try {
      repo.git('init', '-q', empty);
      await expect(computeTarget(empty)).rejects.toThrow(
        new TargetError('empty has no commits yet.'),
      );
      await expect(computeTarget(plain)).rejects.toBeInstanceOf(TargetError);
      await expect(computeTarget(plain)).rejects.toThrow('plain is not a git repository.');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('includes uncommitted edits and untracked files when reviewing the working tree', async () => {
    const session = path.join(repo.dir, 'src/auth/session.ts');
    const original = fs.readFileSync(session, 'utf8');
    fs.writeFileSync(
      session,
      original.replace('if (!token) return null;', 'if (!token) return undefined;'),
    );
    fs.writeFileSync(path.join(repo.dir, 'NOTES.md'), 'one\ntwo');
    try {
      const committed = await computeTarget(repo.dir);
      expect(committed.workTree).toBe(false);
      expect(committed.files.map(filePath)).not.toContain('NOTES.md');

      const t = await computeTarget(repo.dir, undefined, { workTree: true });
      expect(t.uncommitted.sort()).toEqual(['NOTES.md', 'src/auth/session.ts']);
      const notes = t.files.find((f) => filePath(f) === 'NOTES.md')!;
      expect(notes).toMatchObject({ status: 'added', additions: 2, oldPath: null });
      expect(notes.hunks[0].lines.at(-1)).toMatchObject({
        newLine: 2,
        text: 'two',
        noNewlineAtEnd: true,
      });
      const s = t.files.find((f) => filePath(f) === 'src/auth/session.ts')!;
      expect(s.hunks.flatMap((h) => h.lines).some((l) => l.text.includes('return undefined'))).toBe(
        true,
      );
      expect((await readSide(t, 'new', 'src/auth/session.ts'))?.[6]).toBe(
        '  if (!token) return undefined;',
      );
      expect((await readSide(committed, 'new', 'src/auth/session.ts'))?.[6]).toBe(
        '  if (!token) return null;',
      );
    } finally {
      fs.writeFileSync(session, original);
      fs.rmSync(path.join(repo.dir, 'NOTES.md'));
    }
  });

  it("never rewrites .git/index, so a commit made meanwhile cannot meet Review Desk's lock", async () => {
    // A file only touched (same content) makes `git diff` and `git status` refresh the index.
    const api = path.join(repo.dir, 'src/lib/api-client.ts');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(api, later, later);
    const index = path.join(repo.dir, '.git', 'index');
    const before = fs.statSync(index).mtimeMs;
    const t = await computeTarget(repo.dir, undefined, { workTree: true });
    expect(fs.statSync(index).mtimeMs).toBe(before);
    // Touched is not changed.
    expect(t.uncommitted).not.toContain('src/lib/api-client.ts');
  });

  it("reads the diff whatever the user's color settings say", async () => {
    repo.git('config', 'color.diff', 'always');
    try {
      const t = await computeTarget(repo.dir, 'main');
      expect(t.files.length).toBeGreaterThan(0);
      expect(t.files.every((f) => !filePath(f).includes('\u001b'))).toBe(true);
    } finally {
      repo.git('config', '--unset', 'color.diff');
    }
  });

  it('reads either side of a file, following renames', async () => {
    const t = await computeTarget(repo.dir);
    const newSide = await readSide(t, 'new', 'src/auth/session.ts');
    const oldSide = await readSide(t, 'old', 'src/auth/session.ts');
    expect(newSide?.[7]).toBe('  if (isExpired(token)) {');
    expect(oldSide?.[4]).toBe('  const token = req.cookies.token;');
    expect(await readSide(t, 'new', 'does/not/exist.ts')).toBeNull();

    repo.git('switch', '-q', 'feat/rename');
    try {
      const r = await computeTarget(repo.dir);
      expect((await readSide(r, 'old', 'src/lib/httpClient.ts'))?.[0]).toBe(
        '/** Minimal JSON helpers around fetch. */',
      );
    } finally {
      repo.git('switch', '-q', 'feat/refresh');
    }
  });

  it('keeps file contents read from a commit', async () => {
    const t = await computeTarget(repo.dir);
    const first = await readSide(t, 'old', 'src/auth/session.ts');
    expect(first?.length).toBeGreaterThan(0);
    // A commit's content never changes: the second read asks git nothing.
    setGitPath('/nonexistent/git');
    try {
      expect(await readSide(t, 'old', 'src/auth/session.ts')).toEqual(first);
    } finally {
      setGitPath('git');
    }
  });
});
