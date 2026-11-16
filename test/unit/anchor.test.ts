import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anchorCandidates,
  checkRange,
  resolveAnchor,
  resolveAnnotations,
} from '../../src/review/anchor';
import type { Annotation } from '../../src/review/model';
import { computeTarget, fileDigest, readSide, type ReviewTarget } from '../../src/review/target';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

const LINES = ['a', '  if (x) {', '    y();', '  }', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

describe('resolveAnchor', () => {
  it('accepts the stated line, ignoring surrounding and repeated whitespace', () => {
    expect(resolveAnchor(LINES, 2, 4, 'if  (x) {')).toEqual({ state: 'ok', start: 2, end: 4 });
  });

  it('moves the range to the nearest matching line', () => {
    expect(resolveAnchor(LINES, 5, 7, 'if (x) {')).toEqual({ state: 'moved', start: 2, end: 4 });
    expect(resolveAnchor(LINES, 1, 1, '    y();')).toEqual({ state: 'moved', start: 3, end: 3 });
  });

  it('finds a distinctive line however far it moved, and gives up when it is gone', () => {
    // Lines added above: ten of them, past any small window.
    const pushed = [...Array<string>(10).fill('// added'), ...LINES];
    expect(resolveAnchor(pushed, 2, 4, 'if (x) {')).toEqual({ state: 'moved', start: 12, end: 14 });
    expect(resolveAnchor(LINES, 2, 2, 'nothing like it').state).toBe('stale');
  });

  it('does not move a line that appears anywhere (a brace): stale, not on another one', () => {
    const braces = ['a() {', '}', 'b() {', '  c();', '}', 'd();'];
    // The note was on the `}` of line 5; a line added above: its `}` is on line 6 now, and the
    // nearest `}` to line 5 is someone else's.
    const shifted = ['// added', ...braces];
    expect(resolveAnchor(shifted, 5, 5, '}').state).toBe('stale');
    expect(resolveAnchor(braces, 5, 5, '}')).toEqual({ state: 'ok', start: 5, end: 5 });
  });

  it('keeps the end inside the file after moving', () => {
    const lines = [...LINES.slice(0, 10), 'hello()'];
    expect(resolveAnchor(lines, 7, 11, 'hello()')).toEqual({ state: 'moved', start: 11, end: 11 });
  });
});

describe('anchorCandidates', () => {
  it('lists nearby lines that contain the anchor, nearest first', () => {
    expect(anchorCandidates(LINES, 'y()', 8)).toEqual([{ line: 3, text: '    y();' }]);
    expect(anchorCandidates(LINES, '', 3)).toEqual([]);
  });
});

describe('with the fixture repository', () => {
  let repo: FixtureRepo;
  let target: ReviewTarget;
  const base: Omit<Annotation, 'id' | 'startLine' | 'endLine' | 'anchorText'> = {
    file: 'src/auth/session.ts',
    side: 'new',
    kind: 'how',
    title: 't',
    body: '',
  };

  beforeAll(async () => {
    repo = fixtureCopy();
    target = await computeTarget(repo.dir);
  });
  afterAll(() => removeFixture(repo));

  it('checks ranges against the hunks', () => {
    const a = { ...base, id: 'a', startLine: 8, endLine: 13, anchorText: '' };
    expect(checkRange(target, a)).toBeNull();
    expect(checkRange(target, { ...a, file: 'src/auth/token.ts' })).toEqual({
      code: 'FILE_NOT_IN_DIFF',
    });
    expect(checkRange(target, { ...a, file: 'src/auth/token.ts', kind: 'context' })).toBeNull();
    expect(checkRange(target, { ...a, startLine: 9, endLine: 8 })).toEqual({ code: 'BAD_RANGE' });
    expect(
      checkRange(target, { ...a, file: 'test/auth/session.test.ts', startLine: 1, endLine: 1 }),
    ).toEqual({
      code: 'OUT_OF_DIFF',
    });
  });

  it('numbers annotations in reading order and resolves anchors', async () => {
    const resolved = await resolveAnnotations(target, [
      { ...base, id: 'stale', startLine: 3, endLine: 3, anchorText: 'no such line', order: 3 },
      {
        ...base,
        id: 'moved',
        startLine: 10,
        endLine: 15,
        anchorText: 'if (isExpired(token)) {',
        order: 2,
      },
      {
        ...base,
        id: 'ok',
        startLine: 6,
        endLine: 6,
        anchorText: 'const token = req.cookies.token ?? readBearer(req);',
        order: 1,
      },
      {
        ...base,
        id: 'old',
        side: 'old',
        startLine: 5,
        endLine: 5,
        anchorText: 'const token = req.cookies.token;',
        order: 4,
      },
    ]);
    expect(resolved.map((r) => [r.id, r.number, r.state, r.resolvedStart, r.resolvedEnd])).toEqual([
      ['ok', 1, 'ok', 6, 6],
      ['moved', 2, 'moved', 8, 13],
      ['stale', 3, 'stale', 3, 3],
      ['old', 4, 'ok', 5, 5],
    ]);
  });

  it('tells a note on a whole file is outdated by the file it was written for', async () => {
    const lines = await readSide(target, 'new', 'src/auth/session.ts');
    const now = fileDigest(target, 'src/auth/session.ts', lines);
    const note = { ...base, kind: 'overview' as const, startLine: 0, endLine: 0 };
    const resolved = await resolveAnnotations(target, [
      { ...note, id: 'current', anchorText: now, order: 1 },
      { ...note, id: 'older', anchorText: 'written-for-another', order: 2 },
      { ...note, id: 'writing', anchorText: '', order: 3 },
    ]);
    expect(resolved.map((r) => [r.id, r.state, r.resolvedStart, r.resolvedEnd])).toEqual([
      ['current', 'ok', 0, 0],
      ['older', 'stale', 0, 0],
      ['writing', 'ok', 0, 0],
    ]);
    // An unchanged file is fingerprinted by its content.
    const token = await readSide(target, 'new', 'src/auth/token.ts');
    expect(fileDigest(target, 'src/auth/token.ts', token)).not.toBe(
      fileDigest(target, 'src/auth/token.ts', [...token!, 'more']),
    );
  });
});
