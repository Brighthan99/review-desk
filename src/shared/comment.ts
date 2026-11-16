// Reads a PR comment Claude drafted (or the reviewer edited). Shared by the extension (to store
// the card) and the panel (to show the title while it streams).

/** Conventional Comments labels (https://conventionalcomments.org), as Claude is asked to use. */
export const COMMENT_LABELS = [
  'suggestion',
  'issue',
  'nitpick',
  'question',
  'praise',
  'thought',
  'todo',
  'chore',
  'note',
] as const;

export interface ParsedComment {
  /** The Conventional Comments label of its first line (`nit` read as nitpick), if any. */
  label?: string;
  /** For the card: the subject after the label, else the first line. Empty until it is complete. */
  title: string;
  /** The comment as it is posted. */
  body: string;
}

const HEAD = new RegExp(
  `^(?:\\*\\*|__)?(${COMMENT_LABELS.join('|')}|nit)\\b(\\s*\\([^)]*\\))?\\s*(?:\\*\\*|__)?:(?:\\*\\*|__)?\\s*(.*)$`,
  'i',
);

/**
 * The comment starts with a bold Conventional Comments label and its subject
 * (`**issue:** Errors are swallowed`), then the discussion. A first line without one is the
 * title as it is. A reply wrapped in a ```markdown fence is unwrapped.
 */
export function parseComment(text: string, complete = true): ParsedComment {
  let body = text.trim();
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1].trim();
  const newline = body.indexOf('\n');
  if (newline < 0 && !complete) return { title: '', body };
  const first = (newline < 0 ? body : body.slice(0, newline)).trim().replace(/^#+\s*/, '');
  const m = HEAD.exec(first);
  const label = m ? m[1].toLowerCase().replace(/^nit$/, 'nitpick') : undefined;
  const subject = (m ? m[3] : first).replace(/\*\*|__/g, '').trim();
  return { label, title: subject.slice(0, 80) || 'PR comment', body };
}

/** Its ```suggestion blocks as plain code: for lines GitHub cannot take a suggestion on. */
export function withoutSuggestions(body: string): string {
  return body.replace(/^(\s*)```suggestion\b.*$/gm, '$1```');
}
