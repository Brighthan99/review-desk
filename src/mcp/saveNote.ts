import * as fs from 'node:fs';
import * as path from 'node:path';
import { isFileNote, type Annotation, type Kind, type ThreadMessage } from '../review/model';
import { parseComment } from '../shared/comment';
import { ReviewStore } from '../review/store';
import { readSide } from '../review/target';
import { loadReview } from './reviewNotes';

/** Kinds the chat may give a new note: an explanation, or a PR comment for the author. */
export const CHAT_KINDS = ['how', 'why', 'risk', 'context', 'comment'] as const;

export interface SaveRequest {
  /** A note to add the answer to, instead of `file` and lines. */
  id?: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  /** The user's question; without one the answer is an explanation of the lines. */
  question?: string;
  kind?: string;
  title?: string;
  body: string;
}

const newId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const span = (s: number, e: number) => (s === e ? `line ${s}` : `lines ${s}-${e}`);

/** A path in the repository from what the chat passed: relative, `./`-prefixed or absolute. */
function repoPath(root: string, file: string): string | undefined {
  let rel = file.replace(/^\.\//, '');
  if (path.isAbsolute(file)) {
    // git reports the root with symlinks resolved (/private/var on macOS); match that.
    let real = file;
    try {
      real = fs.realpathSync(file);
    } catch {
      // A missing file is reported as missing below.
    }
    rel = path.relative(root, real);
  }
  const posix = path.posix.normalize(rel.split(path.sep).join('/'));
  return !posix ||
    posix === '.' ||
    posix === '..' ||
    posix.startsWith('../') ||
    path.isAbsolute(posix)
    ? undefined
    : posix;
}

function shortTitle(text: string): string {
  // The first line with words (a heading's marks are not a title); never empty.
  const line =
    text
      .split('\n')
      .map((l) => l.trim().replace(/^#+\s*/, ''))
      .find(Boolean) ?? 'Note from the Claude Code chat';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * Saves an answer given in the Claude Code chat into the review of HEAD, the way the panel
 * keeps its own: an explanation becomes a note on the lines, a question a question card, and
 * either one goes into the conversation of the note already on those lines (or of `id`).
 * The extension watches the review file, so the panel shows it at once.
 */
export async function saveNote(cwd: string, req: SaveRequest, now = new Date()): Promise<string> {
  const body = req.body?.trim();
  if (!body) throw new Error('Nothing to save: `body` is empty.');
  const l = await loadReview(cwd);
  if (typeof l === 'string') throw new Error(l);
  if (l.earlierHead) {
    throw new Error(
      'The Review Desk review is of an earlier commit. Reopen the review in VS Code (it follows HEAD) and save again.',
    );
  }
  const { target } = l;
  const store = new ReviewStore(target.gitDir);
  const at = now.toISOString();
  const question = req.question?.trim();

  let existing = req.id ? l.notes.find((a) => a.id === req.id) : undefined;
  if (req.id && !existing) throw new Error(`No note with id ${req.id}.`);
  let card: Annotation | undefined;
  if (!existing) {
    const file = req.file && repoPath(target.root, req.file);
    if (!file) throw new Error('Give the `file` (in the repository) and lines, or a note `id`.');
    const lines = await readSide(target, 'new', file);
    if (!lines) throw new Error(`No file ${file} in ${target.root}.`);
    const start = req.startLine ?? 0;
    const end = req.endLine ?? start;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > lines.length
    ) {
      throw new Error(`${file} has lines 1-${lines.length}; ${start}-${end} is not a range in it.`);
    }
    // A PR comment is a card of its own, beside any note on the same lines.
    const comment = !question && req.kind === 'comment';
    existing = comment
      ? undefined
      : l.notes.find(
          (a) =>
            a.kind !== 'comment' &&
            a.file === file &&
            a.side === 'new' &&
            !isFileNote(a) &&
            a.state !== 'stale' &&
            a.resolvedStart === start &&
            a.resolvedEnd === end,
        );
    if (!existing) {
      const kind: Kind = question
        ? 'question'
        : (((CHAT_KINDS as readonly string[]).includes(req.kind ?? '') ? req.kind : 'how') as Kind);
      card = {
        id: newId(),
        file,
        side: 'new',
        startLine: start,
        endLine: end,
        anchorText: lines[start - 1],
        kind,
        title: comment
          ? parseComment(body).title || shortTitle(body)
          : shortTitle(req.title?.trim() || question || body),
        body: question ? '' : body,
        group: question ? 'Questions' : file,
        origin: 'chat',
        ...(question && {
          thread: [
            { from: 'user', body: question, at, origin: 'chat' },
            { from: 'ai', body, at, origin: 'chat' },
          ] satisfies ThreadMessage[],
        }),
      };
    }
  }

  // Changed on the review as stored now: the extension may have written since it was read.
  const stored = store.load(target.head.sha);
  if (stored.kind !== 'ok') throw new Error('The Review Desk review file could not be read.');
  const review = stored.review;
  if (card) {
    card.order = Math.max(0, ...review.annotations.map((a) => a.order ?? 0)) + 1;
    review.annotations.push(card);
    store.save(review);
    const what =
      card.kind === 'question'
        ? 'question card'
        : card.kind === 'comment'
          ? 'PR comment (the user can edit it and post it to the pull request from the panel)'
          : 'note';
    return `Saved in Review Desk as a ${what} on ${card.file}, ${span(card.startLine, card.endLine)} (id ${card.id}). It shows in the Review Desk panel.`;
  }
  const note = review.annotations.find((a) => a.id === existing!.id);
  if (!note) throw new Error(`No note with id ${existing!.id}.`);
  note.thread = [
    ...(note.thread ?? []),
    { from: 'user', body: question || 'Explained in the Claude Code chat.', at, origin: 'chat' },
    { from: 'ai', body, at, origin: 'chat' },
  ];
  store.save(review);
  return `Added to the conversation of the Review Desk note "${note.title}" (id ${note.id}), which was already on those lines. It shows in the Review Desk panel.`;
}
