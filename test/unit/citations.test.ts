import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPreview, previewDocument, type ReviewPayload } from '../../src/github/convert';
import { checkCitations, citedPaths } from '../../src/review/citations';
import { computeTarget, type ReviewTarget } from '../../src/review/target';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('citedPaths', () => {
  it('takes code spans that name a file, not code or member names', () => {
    expect(
      citedPaths([
        'See `src/auth/session.ts:9`, `session.ts`, `user.locked`, `refresh()` and `a/b`.',
        '```ts\nconst x = `src/in/code.ts`;\n```\nThen `README.md:2-4`.',
      ]),
    ).toEqual(['src/auth/session.ts:9', 'session.ts', 'README.md:2-4']);
  });
});

describe('checkCitations', () => {
  let repo: FixtureRepo;
  let target: ReviewTarget;

  beforeAll(async () => {
    repo = fixtureCopy();
    target = await computeTarget(repo.dir);
  });
  afterAll(() => removeFixture(repo));

  it('links what exists, and says what does not', async () => {
    const map = await checkCitations(target, [
      'src/auth/session.ts:9',
      'session.ts',
      'src/auth/session.ts:900',
      'src/nowhere.ts',
    ]);
    expect(map['src/auth/session.ts:9']).toEqual({ file: 'src/auth/session.ts', line: 9 });
    expect(map['session.ts']).toEqual({ file: 'src/auth/session.ts' });
    expect(map['src/auth/session.ts:900'].problem).toMatch(/line 900 is past its end/);
    expect(map['src/nowhere.ts']).toEqual({
      problem: 'No file src/nowhere.ts in the repository: the AI may have named it wrongly.',
    });
  });
});

describe('review preview', () => {
  const payload: ReviewPayload = {
    body: 'Summary.',
    comments: [
      { path: 'a.ts', body: 'one', line: 3, side: 'RIGHT', annotationId: 'n1' },
      { path: 'a.ts', body: 'two', line: 9, side: 'RIGHT', annotationId: 'n2' },
    ],
    fileComments: [{ path: 'b.ts', body: 'three', annotationId: 'n3' }],
    inBody: [],
    skipped: [{ id: 'q1', reason: 'reviewer question' }],
  };

  it('posts each part as edited, and leaves out a deleted or emptied one', () => {
    const doc = previewDocument(payload, ['# Preview']);
    expect(doc).toContain('<!-- review-desk:line n1 · a.ts 3 (RIGHT) -->\none');
    const edited = doc
      .replace('\none\n', '\nONE, edited\n')
      .replace(/<!-- review-desk:line n2[^\n]*-->\ntwo\n/, '')
      .replace('\nthree\n', '\n\n');
    const out = applyPreview(payload, edited);
    expect(out.body).toBe('Summary.');
    expect(out.comments.map((c) => [c.annotationId, c.body])).toEqual([['n1', 'ONE, edited']]);
    expect(out.fileComments).toEqual([]);
  });

  it('keeps the payload as it is when nothing was edited', () => {
    const out = applyPreview(payload, previewDocument(payload, ['# Preview']));
    expect(out.comments).toEqual(payload.comments);
    expect(out.fileComments).toEqual(payload.fileComments);
    expect(out.body).toBe(payload.body);
  });
});
