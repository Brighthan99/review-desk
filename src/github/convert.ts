import { filePath, hunkSpan, type Side } from '../review/diffParser';
import { withoutSuggestions } from '../shared/comment';
import { summaryMarkdown } from '../shared/summary';
import {
  isFileNote,
  KIND_LABELS,
  type Annotation,
  type ResolvedAnnotation,
  type Review,
  type ThreadMessage,
} from '../review/model';
import { findFile, type ReviewTarget } from '../review/target';
import type { NewReviewComment, ReviewComment } from './client';

export interface ReviewPayload {
  /** Review body: the overview plus notes that cannot sit on a line of the PR. */
  body: string;
  /** Line comments; each range lies inside one hunk, as GitHub requires. */
  comments: (NewReviewComment & { annotationId: string })[];
  /** Comments on a file of the PR but outside its hunks. */
  fileComments: { path: string; body: string; annotationId: string }[];
  /** Annotations folded into the body (files outside the PR). */
  inBody: string[];
  /** Not posted: reviewer questions, imported GitHub threads, unfinished or stale notes. */
  skipped: { id: string; reason: string }[];
}

const SIGNATURE = '<sub>Notes written with the Review Desk extension</sub>';

/**
 * What a note says on the pull request: a PR comment as it is written (its suggestions as plain
 * code where GitHub cannot take them, `suggestible` false), an explanation with its number,
 * title and kind.
 */
function commentBody(a: ResolvedAnnotation, suggestible = false): string {
  if (a.kind === 'comment') return suggestible ? a.body.trim() : withoutSuggestions(a.body.trim());
  return `**${a.number}. ${a.title}** · _${KIND_LABELS[a.kind]}_\n\n${a.body}`.trim();
}

/** The part of [start, end] inside the first hunk it touches on that side, if any. */
function clampToHunk(
  target: ReviewTarget,
  file: string,
  side: Side,
  start: number,
  end: number,
): [number, number] | undefined {
  const f = findFile(target, file);
  if (!f) return undefined;
  for (const h of f.hunks) {
    const span = hunkSpan(h, side);
    if (span && start <= span[1] && end >= span[0])
      return [Math.max(start, span[0]), Math.min(end, span[1])];
  }
  return undefined;
}

/**
 * Turns AI annotations into one GitHub review (plus file-level comments). Its body has the
 * summary of the change unless `withSummary` is false (PR comments posted on their own).
 */
export function buildReviewPayload(
  target: ReviewTarget,
  review: Review,
  annotations: ResolvedAnnotation[],
  only?: Set<string>,
  withSummary = true,
): ReviewPayload {
  const payload: ReviewPayload = {
    body: '',
    comments: [],
    fileComments: [],
    inBody: [],
    skipped: [],
  };
  const bodyNotes: string[] = [];

  for (const a of annotations) {
    if (only && !only.has(a.id)) continue;
    if (a.kind === 'question') {
      payload.skipped.push({ id: a.id, reason: 'reviewer question' });
      continue;
    }
    if (a.source) {
      payload.skipped.push({ id: a.id, reason: 'imported from GitHub' });
      continue;
    }
    if (a.pending) {
      payload.skipped.push({ id: a.id, reason: 'not written yet' });
      continue;
    }
    if (a.state === 'stale') {
      payload.skipped.push({ id: a.id, reason: 'outdated: the code changed' });
      continue;
    }
    const changed = a.file ? findFile(target, a.file) : undefined;
    const wholeFile = isFileNote(a);
    if (!changed) {
      const where = !a.file
        ? 'whole change'
        : wholeFile
          ? `\`${a.file}\``
          : `\`${a.file}\` ${a.resolvedStart}–${a.resolvedEnd}`;
      bodyNotes.push(
        a.kind === 'comment'
          ? `- ${where}:\n\n${commentBody(a).replace(/^/gm, '  ')}`
          : `- ${where}: ${commentBody(a).replace(/\n+/g, ' ')}`,
      );
      payload.inBody.push(a.id);
      continue;
    }
    const path = a.side === 'old' ? (changed.oldPath ?? a.file) : filePath(changed);
    if (wholeFile) {
      payload.fileComments.push({ path, body: commentBody(a), annotationId: a.id });
      continue;
    }
    const range = clampToHunk(target, a.file, a.side, a.resolvedStart, a.resolvedEnd);
    if (!range) {
      payload.fileComments.push({
        path,
        body: `${commentBody(a)}\n\n_(lines ${a.resolvedStart}–${a.resolvedEnd})_`,
        annotationId: a.id,
      });
      continue;
    }
    const side = a.side === 'old' ? 'LEFT' : 'RIGHT';
    // A suggestion replaces the lines the comment is on: only when it stays on all of them.
    const whole = range[0] === a.resolvedStart && range[1] === a.resolvedEnd;
    const c: NewReviewComment & { annotationId: string } = {
      path,
      body: commentBody(a, side === 'RIGHT' && whole),
      line: range[1],
      side,
      annotationId: a.id,
    };
    if (range[0] !== range[1]) {
      c.start_line = range[0];
      c.start_side = side;
    }
    payload.comments.push(c);
  }

  const parts = [withSummary && review.overview ? summaryMarkdown(review.overview) : ''];
  if (bodyNotes.length) parts.push(`**Context outside this PR**\n\n${bodyNotes.join('\n')}`);
  parts.push(SIGNATURE);
  payload.body = parts.filter(Boolean).join('\n\n');
  return payload;
}

/** The comments that GitHub will send as the review's line comments (without our bookkeeping). */
export function apiComments(p: ReviewPayload): NewReviewComment[] {
  return p.comments.map(({ annotationId: _id, ...c }) => c);
}

/**
 * GitHub review threads as read-only question cards: one card per thread root, replies in
 * its conversation. Outdated threads (no current line) become cards about the whole change.
 */
export function threadsToAnnotations(
  comments: ReviewComment[],
  lineText: (side: Side, path: string, line: number) => string,
): Annotation[] {
  const roots = comments
    .filter((c) => !c.in_reply_to_id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const replies = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    if (c.in_reply_to_id)
      replies.set(c.in_reply_to_id, [...(replies.get(c.in_reply_to_id) ?? []), c]);
  }
  return roots.map((root, i): Annotation => {
    const thread = [
      root,
      ...(replies.get(root.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    ];
    const side: Side = root.side === 'LEFT' ? 'old' : 'new';
    const end = root.line ?? 0;
    const start = root.start_line ?? end;
    const firstLine = root.body.split('\n').find((l) => l.trim()) ?? 'Comment';
    return {
      id: `gh${root.id}`,
      file: end ? root.path : '',
      side,
      startLine: start,
      endLine: end,
      anchorText: end ? lineText(side, root.path, start) : '',
      kind: 'question',
      title: (end ? '' : `[${root.path}] `) + firstLine.slice(0, 80),
      body: '',
      group: 'GitHub review',
      order: 10000 + i,
      thread: thread.map((c) => githubMessage(c)),
      source: { type: 'github', url: root.html_url, commentIds: thread.map((c) => c.id) },
    };
  });
}

/** A GitHub comment as a message of a note's conversation. */
function githubMessage(c: ReviewComment): ThreadMessage {
  return {
    from: 'user',
    author: c.user?.login ?? 'GitHub',
    body: c.body,
    at: c.created_at,
    githubId: c.id,
  };
}

const byTime = (a: ThreadMessage, b: ThreadMessage) => a.at.localeCompare(b.at);

/** Its messages written here (questions and answers), not on GitHub. */
const localMessages = (a: Annotation) =>
  (a.thread ?? []).filter((m) => m.githubId === undefined && !m.author);

export interface ThreadsOptions {
  /** The reviewer's GitHub login: a note they posted is found by it when its id was not kept. */
  me?: string;
  /** Notes posted to the pull request (ids), to find the threads they started. */
  posted: Set<string>;
  /** The first import of this pull request: what GitHub has counts as seen. */
  first: boolean;
}

/**
 * Brings the pull request's review threads into the notes. A thread started by a note posted
 * from here goes into that note's conversation (its replies); any other is a card of its own,
 * as `threadsToAnnotations` makes it. Messages written here stay, in time order with GitHub's;
 * GitHub's are taken as GitHub has them now. What is new since a note was last seen is told by
 * its `seenAt` (see replies.ts): on the first import everything counts as seen; a thread that
 * appears later is new.
 */
export function applyThreads(
  annotations: Annotation[],
  comments: ReviewComment[],
  lineText: (side: Side, path: string, line: number) => string,
  o: ThreadsOptions,
): Annotation[] {
  const roots = comments.filter((c) => !c.in_reply_to_id);
  const notes = annotations.filter((a) => a.source?.type !== 'github');
  const oldCards = new Map(
    annotations.filter((a) => a.source?.type === 'github').map((a) => [a.id, a]),
  );
  // The note each posted thread came from: by the id kept when it was posted, else (posted
  // before ids were kept) the reviewer's own comment on its file and lines.
  const noteOf = new Map<number, Annotation>();
  for (const a of notes) if (a.postedAs) noteOf.set(a.postedAs.commentId, a);
  for (const a of notes) {
    if (a.postedAs || !o.posted.has(a.id) || !o.me) continue;
    const root = roots.find(
      (r) =>
        !noteOf.has(r.id) &&
        r.user?.login === o.me &&
        r.path === a.file &&
        (r.line ?? 0) >= a.startLine &&
        (r.line ?? 0) <= Math.max(a.startLine, a.endLine),
    );
    if (root) {
      a.postedAs = { commentId: root.id, url: root.html_url };
      noteOf.set(root.id, a);
    }
  }
  const latest = (thread: ThreadMessage[]) =>
    thread
      .map((m) => m.at)
      .sort()
      .at(-1);
  for (const [rootId, a] of noteOf) {
    const replies = comments
      .filter((c) => c.in_reply_to_id === rootId)
      .map(githubMessage)
      .sort(byTime);
    a.thread = [...localMessages(a), ...replies].sort(byTime);
    if (!a.thread.length) delete a.thread;
    if (a.seenAt === undefined) {
      const root = roots.find((r) => r.id === rootId);
      a.seenAt = o.first ? (latest(replies) ?? root?.created_at) : root?.created_at;
    }
  }
  const cards = threadsToAnnotations(
    comments.filter((c) => !noteOf.has(c.in_reply_to_id ?? c.id)),
    lineText,
  ).map((card) => {
    const old = oldCards.get(card.id);
    return {
      ...card,
      thread: [...(card.thread ?? []), ...(old ? localMessages(old) : [])].sort(byTime),
      threadSession: old?.threadSession,
      reply: old?.reply,
      threadResolved: old?.threadResolved,
      // Seen as it was; a thread that is new now is new, unless this is the first import.
      seenAt: old?.seenAt ?? (o.first ? latest(card.thread ?? []) : undefined),
    };
  });
  return [...notes, ...cards];
}

/** How a review is posted: comments only, an approval, or a request for changes. */
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

const MARK = /^<!-- review-desk:(body|line|file|end)(?: (\S+))?[^\n]*?-->[ \t]*$/gm;

/**
 * The review as a markdown document the reviewer can edit before posting: each part after a
 * `<!-- review-desk:… -->` marker is posted as it reads then; a part deleted (or emptied) is
 * left out.
 */
export function previewDocument(payload: ReviewPayload, header: string[]): string {
  // A body may hold a line that reads as a marker (a note on this very code): set one space
  // in, it is no marker, and still an HTML comment GitHub shows nothing of.
  const text = (body: string) => body.replace(/^(?=<!-- review-desk:)/gm, ' ');
  const out = [
    ...header,
    '',
    'Edit any text below before posting, or delete a part (from its `<!-- review-desk:… -->` line to the next) to leave it out. Only the parts are posted, not this header.',
    '',
    '<!-- review-desk:body · review body -->',
    text(payload.body),
  ];
  for (const c of payload.comments) {
    const lines = `${c.start_line ? `${c.start_line}–` : ''}${c.line}`;
    out.push(
      '',
      `<!-- review-desk:line ${c.annotationId} · ${c.path} ${lines} (${c.side}) -->`,
      text(c.body),
    );
  }
  for (const c of payload.fileComments)
    out.push(
      '',
      `<!-- review-desk:file ${c.annotationId} · ${c.path} (file comment) -->`,
      text(c.body),
    );
  out.push('', '<!-- review-desk:end -->');
  if (payload.skipped.length) {
    out.push('', '## Not posted', ...payload.skipped.map((s) => `- ${s.id}: ${s.reason}`));
  }
  return out.join('\n');
}

/** The payload as the reviewer left it in the preview document: edited, parts left out. */
export function applyPreview(payload: ReviewPayload, text: string): ReviewPayload {
  const parts = new Map<string, string>();
  const marks = [...text.matchAll(MARK)];
  marks.forEach((m, i) => {
    if (m[1] === 'end') return;
    const from = m.index! + m[0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index! : text.length;
    parts.set(m[1] === 'body' ? 'body' : `${m[1]}:${m[2]}`, text.slice(from, to).trim());
  });
  const kept = (key: string) => !!parts.get(key);
  return {
    ...payload,
    body: parts.get('body') ?? '',
    comments: payload.comments
      .filter((c) => kept(`line:${c.annotationId}`))
      .map((c) => ({ ...c, body: parts.get(`line:${c.annotationId}`)! })),
    fileComments: payload.fileComments
      .filter((c) => kept(`file:${c.annotationId}`))
      .map((c) => ({ ...c, body: parts.get(`file:${c.annotationId}`)! })),
  };
}
