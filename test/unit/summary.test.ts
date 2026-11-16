import { describe, expect, it } from 'vitest';
import { readFile, splitSummary, summaryMarkdown } from '../../src/shared/summary';

const summary = [
  'Tokens are refreshed on the server now.',
  '',
  '### Changes',
  '- **Auth** — refresh in place (`src/auth/session.ts`)',
  '',
  '```mermaid',
  'flowchart TD',
  '  A["request"] --> B["refresh()"]',
  '```',
  '',
  '```review-desk-order',
  '[{"title": "Types first", "why": "Everything uses them.", "files": ["src/auth/types.ts"]},',
  ' {"title": "Refresh", "files": ["src/auth/session.ts:8-20", "`./src/auth/refresh.ts`"]}]',
  '```',
].join('\n');

describe('splitSummary', () => {
  it('takes the diagram and the reading order out of the text', () => {
    const parts = splitSummary(summary);
    expect(parts.text).toBe(
      'Tokens are refreshed on the server now.\n\n### Changes\n- **Auth** — refresh in place (`src/auth/session.ts`)',
    );
    expect(parts.diagram).toBe('flowchart TD\n  A["request"] --> B["refresh()"]');
    expect(parts.order).toEqual([
      {
        title: 'Types first',
        why: 'Everything uses them.',
        files: [{ file: 'src/auth/types.ts' }],
      },
      {
        title: 'Refresh',
        why: undefined,
        files: [
          { file: 'src/auth/session.ts', start: 8, end: 20 },
          { file: 'src/auth/refresh.ts', start: undefined, end: undefined },
        ],
      },
    ]);
    expect(parts.writing).toBeUndefined();
  });

  it('drops a heading written right above a block, and keeps other code blocks', () => {
    const parts = splitSummary(
      'Text.\n\n```ts\nconst a = 1;\n```\n\n### Flow\n\n```mermaid\nflowchart TD\n  A --> B\n```',
    );
    expect(parts.text).toBe('Text.\n\n```ts\nconst a = 1;\n```');
    expect(parts.diagram).toBe('flowchart TD\n  A --> B');
  });

  it('hides a block still being written', () => {
    const partial = summary.slice(0, summary.indexOf('"title": "Refresh"'));
    const parts = splitSummary(partial);
    expect(parts.writing).toBe('order');
    expect(parts.order).toBeUndefined();
    expect(parts.diagram).toBeDefined();
    expect(parts.text).not.toContain('review-desk-order');
  });

  it('says why a broken reading order cannot be read', () => {
    const parts = splitSummary('Text.\n\n```review-desk-order\n[{"title": \n```');
    expect(parts.order).toBeUndefined();
    expect(parts.orderError).toMatch(/not valid JSON/);
    expect(parts.text).toBe('Text.');
  });

  it('leaves a summary without blocks as it is', () => {
    expect(splitSummary('Just text.\n\n- a')).toEqual({ text: 'Just text.\n\n- a' });
  });
});

describe('readFile', () => {
  it('reads a path with an optional line or range', () => {
    expect(readFile('src/a.ts')).toEqual({ file: 'src/a.ts', start: undefined, end: undefined });
    expect(readFile('src/a.ts:12')).toEqual({ file: 'src/a.ts', start: 12, end: 12 });
    expect(readFile('src/a.ts:12–30')).toEqual({ file: 'src/a.ts', start: 12, end: 30 });
    expect(readFile('not a path')).toBeUndefined();
  });
});

describe('summaryMarkdown', () => {
  it('writes the reading order as a list for readers without the panel', () => {
    const md = summaryMarkdown(summary);
    expect(md).toContain('```mermaid\nflowchart TD');
    expect(md).toContain('**Reading order**');
    expect(md).toContain('1. **Types first** — Everything uses them. (`src/auth/types.ts`)');
    expect(md).toContain('2. **Refresh** (`src/auth/session.ts:8-20`, `src/auth/refresh.ts`)');
    expect(md).not.toContain('review-desk-order');
  });
});
