import { describe, expect, it } from 'vitest';
import { parseComment, withoutSuggestions } from '../../src/shared/comment';

describe('PR comments', () => {
  it('reads the Conventional Comments label and subject of the first line as the title', () => {
    const text = '**issue (blocking):** The error is dropped\n\nReturn it instead.';
    expect(parseComment(text)).toEqual({
      label: 'issue',
      title: 'The error is dropped',
      body: text,
    });
    expect(parseComment('nit: spacing').label).toBe('nitpick');
    expect(parseComment('**suggestion**: Use a map').title).toBe('Use a map');
  });

  it('takes a first line without a label as it is, and unwraps a markdown fence', () => {
    expect(parseComment('Looks good to me.')).toEqual({
      label: undefined,
      title: 'Looks good to me.',
      body: 'Looks good to me.',
    });
    expect(parseComment('```markdown\n**praise:** Clean\n\nNice.\n```')).toEqual({
      label: 'praise',
      title: 'Clean',
      body: '**praise:** Clean\n\nNice.',
    });
  });

  it('has no title while its first line is still being written', () => {
    expect(parseComment('**issue:** The er', false).title).toBe('');
  });

  it('turns suggestion blocks into plain code where GitHub takes none', () => {
    expect(withoutSuggestions('**nitpick:** x\n\n```suggestion\nconst a = 1;\n```')).toBe(
      '**nitpick:** x\n\n```\nconst a = 1;\n```',
    );
  });
});
