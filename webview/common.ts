import { createContext } from 'preact';
import type { CitationView, CardKind, CardView } from '../src/shared/protocol';

export interface Answer {
  text: string;
  done: boolean;
  error?: string;
}

/** A note being translated, or why its translation failed. */
export interface Translation {
  running: boolean;
  error?: string;
}

export type Filter = 'all' | CardKind;

export const KIND_ORDER: CardKind[] = [
  'comment',
  'why',
  'how',
  'risk',
  'context',
  'question',
  'overview',
];

export const KIND_NAMES: Record<CardKind, string> = {
  overview: 'Overview',
  why: 'Why',
  how: 'How',
  risk: 'Risk',
  question: 'Questions',
  context: 'Context',
  comment: 'PR Comments',
};

export const EXPLAIN_KEY = navigator.userAgent.includes('Mac') ? '⌘⌥E' : 'Ctrl+Alt+E';

export const EXPLAIN_HINT = `Select lines in any file — changed or not — and run Review Desk: Explain Code (right-click or ${EXPLAIN_KEY}). In a changed file, click Explain above a changed block.`;

export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** What code spans can link to: the changed files, and the cited paths the extension checked. */
export const Links = createContext<{ files: string[]; citations: Record<string, CitationView> }>({
  files: [],
  citations: {},
});

export const lines = (start: number, end: number) =>
  start === end ? `${start}` : `${start}–${end}`;

export const location = (c: CardView) =>
  !c.file
    ? 'Whole change'
    : c.startLine === 0
      ? `${basename(c.file)} · file`
      : `${basename(c.file)} ${lines(c.startLine, c.endLine)}`;
