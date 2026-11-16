import { describe, expect, it } from 'vitest';
import { changeBlocks } from '../../src/review/blocks';
import { parseUnifiedDiff } from '../../src/review/diffParser';

const diff = (body: string) =>
  parseUnifiedDiff(`diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n${body}`)[0];

describe('changeBlocks', () => {
  it('splits a hunk into runs of changed lines', () => {
    const f = diff(
      ['@@ -1,8 +1,9 @@', ' a', '-b', '+B', '+B2', ' c', ' d', '-e', ' f', ' g', '+h', ''].join(
        '\n',
      ),
    );
    expect(changeBlocks(f)).toEqual([
      { newStart: 2, newEnd: 3, side: 'new', start: 2, end: 3, added: 2, deleted: ['b'] },
      { newStart: 6, newEnd: 6, side: 'old', start: 5, end: 5, added: 0, deleted: ['e'] },
      { newStart: 8, newEnd: 8, side: 'new', start: 8, end: 8, added: 1, deleted: [] },
    ]);
  });

  it('puts a deletion at the end of a file after the last line', () => {
    const f = diff(['@@ -1,3 +1,2 @@', ' a', ' b', '-c', ''].join('\n'));
    expect(changeBlocks(f)).toEqual([
      { newStart: 2, newEnd: 2, side: 'old', start: 3, end: 3, added: 0, deleted: ['c'] },
    ]);
  });
});
