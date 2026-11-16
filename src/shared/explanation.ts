// Reads the agent's answer to an explanation request. Shared by the extension (to store the
// card) and the panel (to show the title while the answer streams).

export type ExplanationKind = 'why' | 'how' | 'risk' | 'context' | 'overview';

export interface ParsedExplanation {
  kind: ExplanationKind;
  /** Empty until the first line is complete. */
  title: string;
  body: string;
}

const HEAD = /^\[(why|how|risk|context|overview)\]\s*(.*)$/i;

/**
 * The answer starts with `[kind] title`, then a blank line and the body. Models sometimes
 * wrap the first line in markdown (`## [how] …`, `**[how] …**`); that is tolerated. Without
 * the tag, the first line is the title and the kind defaults to `how`.
 */
export function parseExplanation(text: string, complete = true): ParsedExplanation {
  const trimmed = text.replace(/^\s+/, '');
  const newline = trimmed.indexOf('\n');
  if (newline < 0 && !complete) return { kind: 'how', title: '', body: '' };
  const first = (newline < 0 ? trimmed : trimmed.slice(0, newline))
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .trim();
  const body = newline < 0 ? '' : trimmed.slice(newline + 1).trim();
  const m = HEAD.exec(first);
  const kind = (m?.[1].toLowerCase() ?? 'how') as ExplanationKind;
  const title = (m ? m[2] : first).replace(/^\*\*|\*\*$/g, '').trim();
  return { kind, title: title.slice(0, 80) || 'Note', body };
}
