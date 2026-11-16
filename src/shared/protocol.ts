// Messages between the extension and the explanation panel (webview). Types only, so the
// file can be imported from both bundles.

import type { AgentInfo } from './agentUse';

export type CardKind = 'overview' | 'why' | 'how' | 'risk' | 'question' | 'context' | 'comment';

export interface ThreadEntry {
  from: 'user' | 'ai';
  /** Set when the message is someone else's, e.g. a GitHub reviewer. */
  author?: string;
  body: string;
  at: string;
  selection?: { file: string; startLine: number; endLine: number };
  /** Written in the Claude Code chat. */
  origin?: 'chat';
}

export interface CardView {
  id: string;
  number: number;
  kind: CardKind;
  kindLabel: string;
  title: string;
  /** Markdown. */
  body: string;
  /** Empty for a question about the whole change. */
  file: string;
  side: 'new' | 'old';
  startLine: number;
  endLine: number;
  state: 'ok' | 'moved' | 'stale';
  group?: string;
  understood: boolean;
  thread: ThreadEntry[];
  /** Link to where the card came from (an imported GitHub thread). */
  sourceUrl?: string;
  /** The explanation was requested and is not written yet. */
  pending?: boolean;
  /** Written in the Claude Code chat. */
  fromChat?: boolean;
  /** Has text of Claude's not (known to be) in the panel's language: it can be translated. */
  translatable?: boolean;
  /** A PR comment posted to the pull request: where it is. */
  posted?: string;
  /** It has a GitHub conversation (an imported thread, or replies to it posted from here). */
  githubThread?: boolean;
  /** GitHub replies in it not seen yet (not the reviewer's own). */
  newReplies?: number;
  /** A reply to its GitHub thread being written, not posted. */
  reply?: string;
  /** Its GitHub thread is resolved: by whom, when known (empty when not). */
  resolvedBy?: string;
  resolved?: boolean;
}

export interface PanelState {
  head: string;
  base: string;
  headSha: string;
  /** Files with uncommitted changes included in the review. */
  uncommitted: number;
  /** Paths of the changed files. */
  files: string[];
  /** Summary of the whole change (markdown). */
  overview?: string;
  /** The change moved on since the summary was written. */
  overviewStale?: boolean;
  /** The summary is not (known to be) in `language`: it can be translated. */
  overviewTranslatable?: boolean;
  error?: string;
  cards: CardView[];
  pr?: { number: number; title?: string; url: string };
  /** The language Claude writes notes and answers in (reviewDesk.language). */
  language: string;
  /** Changed files marked viewed, still as viewed or changed since. */
  viewed?: Record<string, 'viewed' | 'changed'>;
  /** GitHub replies not seen yet, in all the notes. */
  newReplies?: number;
  /** The agent Review Desk runs (Claude Code or Codex): which, and with which account. */
  agent?: AgentInfo;
}

export interface SelectionRef {
  file: string;
  startLine: number;
  endLine: number;
}

/** Lines a PR comment is drafted on: after the change (new), or before it (old, deleted lines). */
export interface CommentTarget extends SelectionRef {
  side: 'new' | 'old';
}

export interface FileUse {
  file: string;
  line: number;
  text: string;
  symbol: string;
  /** Card covering that line, if any. */
  cardId?: string;
  cardNumber?: number;
}

/** What the panel shows while an unchanged file is open in the editor. */
export interface ActiveFileInfo {
  file: string;
  uses: FileUse[] | 'loading';
}

/** A summary being written: streaming, or failed. */
export interface SummaryRun {
  text: string;
  done: boolean;
  error?: string;
}

/** What a `path` or `path:line` cited in a note or summary points at, or why it points nowhere. */
export interface CitationView {
  file?: string;
  line?: number;
  problem?: string;
}

/** Where GitHub was last read for the pull request's replies: when, being read now, or why not. */
export interface GithubCheck {
  /** When it was last read (ms since the epoch). */
  at?: number;
  running: boolean;
  error?: string;
}

export type ToPanel =
  | { type: 'state'; state: PanelState | null }
  | { type: 'focus'; id: string | null }
  | { type: 'answer'; cardId: string; text: string; done: boolean; error?: string }
  | { type: 'explain'; cardId: string; text: string; done: boolean; error?: string }
  | { type: 'summary'; run: SummaryRun | null }
  | { type: 'focusSummary' }
  | { type: 'selection'; selection: SelectionRef | null }
  | { type: 'activeFile'; info: ActiveFileInfo | null }
  /** The file the reviewer is on; `focus` when they picked it in the list (show its section). */
  | { type: 'currentFile'; file: string | null; focus?: boolean }
  | { type: 'focusAsk' }
  /**
   * Lines picked to draft a PR comment on (Comment above a block, Draft PR Comment), until
   * other lines are selected; `focus`: switch the box below to PR Comment and type there.
   */
  | { type: 'compose'; target: CommentTarget | null; focus?: boolean }
  /** Cited paths checked against the repository, by the code span's text. */
  | { type: 'citations'; map: Record<string, CitationView> }
  /** GitHub being read for the pull request's replies, or when it last was. */
  | { type: 'githubCheck'; check: GithubCheck | null }
  /** A note being translated into the current language, or done, or failed. */
  | { type: 'translation'; cardId: string; running: boolean; error?: string };

export type FromPanel =
  | { type: 'ready' }
  | { type: 'select'; id: string }
  /** The reviewer closed the open card (clicked its head again). */
  | { type: 'close'; id: string }
  | { type: 'understood'; id: string; value: boolean }
  | {
      type: 'ask';
      cardId: string | null;
      text: string;
      useSelection: boolean;
      /** Without a selection, a new question is about this whole file (else the change). */
      file?: string;
    }
  | { type: 'cancel'; cardId: string }
  | { type: 'retry'; id: string }
  | { type: 'summarize' }
  | { type: 'summarizeFile'; file: string }
  | { type: 'cancelSummary' }
  | { type: 'remove'; id: string }
  | { type: 'reveal'; file: string; line: number }
  | { type: 'start' }
  | { type: 'changeLanguage' }
  /** Show the files in the suggested reading order in the Review list. */
  | { type: 'showReadingOrder' }
  /** Translate a note into the current language. */
  | { type: 'translate'; id: string }
  /** Draft a PR comment on these lines, saying `request` (empty: what Claude finds). */
  | { type: 'draftComment'; target: CommentTarget; request: string }
  /** Read the pull request on GitHub now: its state and its review threads' replies. */
  | { type: 'syncGithub' }
  /** The agent label in the header was clicked: the list of agents to pick from. */
  | { type: 'chooseAgent' }
  /** Have Claude sum up a note's GitHub conversation (its answer goes into the conversation). */
  | { type: 'summarizeThread'; id: string }
  /** Have Claude draft a reply in a note's GitHub thread. */
  | { type: 'draftReply'; id: string }
  /** Post a reply in a note's GitHub thread, as written. */
  | { type: 'postReply'; id: string; body: string }
  /** Drop the reply drafted for a note. */
  | { type: 'discardReply'; id: string }
  /** A PR comment as the reviewer edited it. */
  | { type: 'editComment'; id: string; body: string }
  /** Post a PR comment to the pull request now, on its own. */
  | { type: 'postComment'; id: string }
  /** Something failed in the panel's own code: for the log. */
  | { type: 'error'; message: string; stack?: string };
