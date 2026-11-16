import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSavedReviews, pruneBranchReviews } from '../../src/review/savedReviews';

const sha = (c: string) => c.repeat(40);
const review = (head: string, headSha: string, notes: number) => ({
  version: 1,
  base: { ref: 'main', sha: sha('0') },
  head: { ref: head, sha: headSha },
  status: 'done',
  annotations: Array.from({ length: notes }, (_, i) => ({
    id: `a${i}`,
    file: 'f.ts',
    startLine: 1,
    endLine: 1,
    anchorText: 'x',
    kind: 'how',
    title: 't',
    body: '',
  })),
});

describe('listSavedReviews', () => {
  let dir: string;
  const write = (headSha: string, r: unknown, mtime: number) => {
    const file = path.join(dir, `${headSha}.json`);
    fs.writeFileSync(file, JSON.stringify(r));
    fs.utimesSync(file, mtime, mtime);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-saved-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps the newest file of each branch, newest branch first', () => {
    write(sha('a'), review('feat/x', sha('a'), 1), 1000);
    write(sha('b'), review('feat/x', sha('b'), 2), 3000);
    write(sha('c'), review('fix/y', sha('c'), 0), 2000);
    fs.writeFileSync(path.join(dir, `${sha('d')}.json`), '{ broken');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const saved = listSavedReviews(dir);
    expect(
      saved.map((s) => [s.review.head.ref, s.review.annotations.length, s.files.length]),
    ).toEqual([
      ['feat/x', 2, 2],
      ['fix/y', 0, 1],
    ]);
  });

  it('has nothing for a missing store', () => {
    expect(listSavedReviews(path.join(dir, 'nope'))).toEqual([]);
  });

  it('reads a file again once it changed', () => {
    write(sha('a'), review('feat/x', sha('a'), 1), 1000);
    expect(listSavedReviews(dir)[0].review.annotations).toHaveLength(1);
    write(sha('a'), review('feat/x', sha('a'), 3), 2000);
    expect(listSavedReviews(dir)[0].review.annotations).toHaveLength(3);
  });

  it('prunes a branch to its newest heads, keeping the open one', () => {
    for (const [i, c] of ['1', '2', '3', '4', '5'].entries()) {
      write(sha(c), review('feat/x', sha(c), 1), 1000 + i);
    }
    write(sha('f'), review('fix/y', sha('f'), 1), 10);
    const file = (c: string) => path.join(dir, `${sha(c)}.json`);

    // The oldest head is open (checked out again): it stays, with the newest three.
    const removed = pruneBranchReviews(dir, 'feat/x', file('1'));
    expect(removed.sort()).toEqual([file('2')]);
    expect(fs.readdirSync(dir).sort()).toEqual(
      [sha('1'), sha('3'), sha('4'), sha('5'), sha('f')].map((h) => `${h}.json`),
    );
    expect(pruneBranchReviews(dir, 'feat/x', file('5'))).toEqual([file('1')]);
    expect(listSavedReviews(dir).find((r) => r.review.head.ref === 'feat/x')?.files).toHaveLength(
      3,
    );
  });
});
