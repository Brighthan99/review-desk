import { describe, expect, it } from 'vitest';
import { fenced, markdownText } from '../../src/shared/markdownText';

describe('text in hover markdown', () => {
  it('shows a title as text: no link of its own', () => {
    const title = 'Fix [this](command:workbench.action.terminal.new) *now*';
    const escaped = markdownText(title);
    expect(escaped).not.toContain('](');
    expect(escaped).toBe(
      'Fix \\[this\\]\\(command:workbench\\.action\\.terminal\\.new\\) \\*now\\*',
    );
  });

  it('fences code with more backticks than any run in it', () => {
    expect(fenced('a = 1', 'ts')).toBe('```ts\na = 1\n```');
    const code = 'const s = `x`;\n```\n[run](command:x)';
    const block = fenced(code, 'md');
    expect(block.startsWith('````md\n')).toBe(true);
    expect(block.endsWith('\n````')).toBe(true);
  });
});
