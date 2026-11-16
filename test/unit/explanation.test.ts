import { describe, expect, it } from 'vitest';
import { parseExplanation } from '../../src/shared/explanation';

describe('parseExplanation', () => {
  it('reads the kind and title from the first line and the rest as the body', () => {
    expect(
      parseExplanation(
        '[risk] Refreshed twice at once\n\nWhen two requests overlap\nboth refresh.',
      ),
    ).toEqual({
      kind: 'risk',
      title: 'Refreshed twice at once',
      body: 'When two requests overlap\nboth refresh.',
    });
  });

  it('tolerates markdown around the first line and an upper-case kind', () => {
    expect(parseExplanation('## [WHY] Header token\nBody').kind).toBe('why');
    expect(parseExplanation('**[how] Refresh in place**\n\nBody')).toMatchObject({
      kind: 'how',
      title: 'Refresh in place',
    });
  });

  it('falls back to `how` with the first line as the title', () => {
    expect(parseExplanation('Refreshes the token\n\nDetails')).toEqual({
      kind: 'how',
      title: 'Refreshes the token',
      body: 'Details',
    });
  });

  it('has no title while the first line is still streaming', () => {
    expect(parseExplanation('[how] In pla', false).title).toBe('');
    expect(parseExplanation('[how] In place\nRe', false)).toMatchObject({
      title: 'In place',
      body: 'Re',
    });
  });
});
