import { describe, expect, it } from 'vitest';
import {
  buildTranslatePrompt,
  needsTranslation,
  parseTranslation,
  summaryNeedsTranslation,
  summaryPieces,
  translatableParts,
} from '../../src/agent/translate';
import { splitSummary } from '../../src/shared/summary';
import type { Annotation } from '../../src/review/model';

const note = (over: Partial<Annotation> = {}): Annotation => ({
  id: 'a1',
  file: 'src/a.ts',
  side: 'new',
  startLine: 1,
  endLine: 2,
  anchorText: 'x',
  kind: 'why',
  title: 'Retries removed',
  body: 'The server refreshes the token.',
  ...over,
});

describe('translating notes', () => {
  it("picks Claude's text: the title and body, and the answers, not the questions", () => {
    const thread = [
      { from: 'user' as const, body: 'Why?', at: '1' },
      { from: 'ai' as const, body: 'Because.', at: '2' },
      { from: 'ai' as const, author: 'octocat', body: 'A GitHub reply', at: '3' },
    ];
    expect(translatableParts(note({ thread }))).toEqual([
      { slot: 'title', text: 'Retries removed' },
      { slot: 'body', text: 'The server refreshes the token.' },
      { slot: 1, text: 'Because.' },
    ]);
    // A question card's title is the question; an imported or unwritten note has none.
    expect(translatableParts(note({ kind: 'question', title: 'Why?', body: '', thread }))).toEqual([
      { slot: 1, text: 'Because.' },
    ]);
    const source = { type: 'github' as const, url: 'u', commentIds: [1] };
    expect(translatableParts(note({ source }))).toEqual([]);
    expect(translatableParts(note({ pending: true }))).toEqual([]);
  });

  it('offers it for a note not known to be in the language', () => {
    expect(needsTranslation(note(), 'Korean')).toBe(true);
    expect(needsTranslation(note({ language: 'korean' }), 'Korean')).toBe(false);
    expect(needsTranslation(note({ language: 'English' }), 'Korean')).toBe(true);
    expect(needsTranslation(note({ kind: 'question', body: '' }), 'Korean')).toBe(false);
  });

  it('asks for a JSON array back, and takes only one of the same length', () => {
    const prompt = buildTranslatePrompt(['a `b`', 'c'], 'Korean');
    expect(prompt.split('\n')[0]).toBe('[Review Desk: translate]');
    expect(prompt).toContain('into Korean');
    expect(prompt.endsWith('["a `b`","c"]')).toBe(true);
    expect(parseTranslation('```json\n["A `b`", "C"]\n```', 2)).toEqual(['A `b`', 'C']);
    expect(parseTranslation('["A"]', 2)).toBeUndefined();
    expect(parseTranslation('[1, 2]', 2)).toBeUndefined();
    expect(parseTranslation('not json', 1)).toBeUndefined();
  });

  it("translates a summary's text and reading order, keeping its diagram and files", () => {
    const overview = [
      'Tokens are refreshed on the server.',
      '',
      '### Flow',
      '```mermaid',
      'flowchart LR',
      '  A[Request] --> B[Refresh]',
      '```',
      '',
      '```review-desk-order',
      JSON.stringify([
        {
          title: 'Types first',
          why: 'They are used below.',
          files: ['src/a.ts', 'src/b.ts:40-72'],
        },
        { title: 'Tests', files: ['test/a.test.ts'] },
      ]),
      '```',
    ].join('\n');
    const pieces = summaryPieces(overview)!;
    expect(pieces.texts).toEqual([
      'Tokens are refreshed on the server.',
      'Types first',
      'They are used below.',
      'Tests',
      '',
    ]);
    const parts = splitSummary(
      pieces.rebuild([
        'TOKENS ARE REFRESHED ON THE SERVER.',
        'TYPES FIRST',
        'THEY ARE USED BELOW.',
        'TESTS',
        '',
      ]),
    );
    expect(parts.text).toBe('TOKENS ARE REFRESHED ON THE SERVER.');
    expect(parts.diagram).toBe('flowchart LR\n  A[Request] --> B[Refresh]');
    expect(parts.order).toEqual([
      {
        title: 'TYPES FIRST',
        why: 'THEY ARE USED BELOW.',
        files: [{ file: 'src/a.ts' }, { file: 'src/b.ts', start: 40, end: 72 }],
      },
      { title: 'TESTS', files: [{ file: 'test/a.test.ts' }] },
    ]);

    // Known to be in the language: nothing to offer. A broken reading order: not touched.
    const review = { overview, overviewLanguage: 'Korean' } as Parameters<
      typeof summaryNeedsTranslation
    >[0];
    expect(summaryNeedsTranslation(review, 'korean')).toBe(false);
    expect(summaryNeedsTranslation({ ...review, overviewLanguage: undefined }, 'Korean')).toBe(
      true,
    );
    expect(summaryPieces('Text\n\n```review-desk-order\nnot json\n```')).toBeUndefined();
  });
});
