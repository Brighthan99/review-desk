import * as path from 'node:path';
import { summaryMarkdown } from '../shared/summary';
import { resolveAnnotations } from '../review/anchor';
import { git } from '../review/git';
import {
  isFileNote,
  KIND_LABELS,
  type ResolvedAnnotation,
  type Review,
  type ThreadMessage,
} from '../review/model';
import { listSavedReviews } from '../review/savedReviews';
import { ReviewStore } from '../review/store';
import { computeTarget, diffDigest, repoRoot, type ReviewTarget } from '../review/target';

/** Longest answer of `notes`; the rest is named so it can be asked for. */
export const MAX_NOTES_CHARS = 40_000;

export interface LoadedReview {
  review: Review;
  target: ReviewTarget;
  /** Notes in reading order, with lines matched to the current code. */
  notes: ResolvedAnnotation[];
  /** Written at another commit of the branch: HEAD has moved since and no review followed. */
  earlierHead?: string;
}

/**
 * The review of the repository's current HEAD, as the Review Desk panel shows it: the review file
 * of HEAD, else the latest one of the branch, with the diff computed the same way.
 * A string says why there is none.
 */
export async function loadReview(cwd: string): Promise<LoadedReview | string> {
  let root: string;
  try {
    root = await repoRoot(cwd);
  } catch {
    return `${cwd} is not in a git repository.`;
  }
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const store = new ReviewStore(gitDir);
  const stored = store.load(head);
  let review: Review | undefined;
  let earlierHead: string | undefined;
  if (stored.kind === 'ok') review = stored.review;
  else if (stored.kind === 'invalid')
    return `The Review Desk review file is invalid: ${stored.error}`;
  else {
    const branch = (await git(root, ['branch', '--show-current'])).trim();
    review = branch
      ? listSavedReviews(store.dir).find((s) => s.review.head.ref === branch)?.review
      : undefined;
    earlierHead = review?.head.sha;
  }
  if (!review) {
    return 'There is no Review Desk review of the current branch in this repository. The user can start one in VS Code with "Review Desk: Start Review".';
  }
  let target: ReviewTarget;
  try {
    target = await computeTarget(root, review.base.ref, { workTree: review.workTree ?? true });
  } catch (e) {
    return `Could not compute the change under review: ${e instanceof Error ? e.message : String(e)}`;
  }
  const notes = await resolveAnnotations(target, review.annotations);
  return { review, target, notes, earlierHead };
}

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function lines(a: ResolvedAnnotation): string {
  if (!a.file) return 'the whole change';
  if (isFileNote(a)) return 'whole file';
  const span =
    a.resolvedStart === a.resolvedEnd
      ? `line ${a.resolvedStart}`
      : `lines ${a.resolvedStart}-${a.resolvedEnd}`;
  return a.side === 'old' ? `${span} of the base version` : span;
}

function followUps(a: ResolvedAnnotation): number {
  return (a.thread ?? []).filter((m) => m.from === 'user').length;
}

function state(a: ResolvedAnnotation): string | undefined {
  if (a.pending) return 'still being written';
  if (a.state === 'stale') {
    return isFileNote(a)
      ? 'outdated: the file has changed since'
      : 'outdated: the code it describes has changed';
  }
  return undefined;
}

function header(l: LoadedReview): string {
  const { review, target } = l;
  const range = target.workTree
    ? `git diff ${short(target.base.sha)}`
    : `git diff ${short(target.base.sha)} ${short(target.head.sha)}`;
  const to = target.workTree ? 'the working tree, uncommitted edits included' : 'HEAD';
  const files = plural(target.files.length, 'file');
  const out =
    review.base.ref === 'HEAD'
      ? [
          `# Review Desk: uncommitted changes on ${target.head.ref}`,
          `The change is \`git diff HEAD\`: ${files}.`,
        ]
      : [
          `# Review Desk: ${target.head.ref} against ${review.base.ref}`,
          `The change is \`${range}\` (from the merge base of ${review.base.ref} and HEAD to ${to}): ${files}.`,
        ];
  out.push(`Repository: ${target.root} (note paths are relative to it).`);
  if (l.earlierHead) {
    out.push(
      `The notes were written at an earlier commit of the branch (${short(l.earlierHead)}); their line numbers are matched to the current code.`,
    );
  }
  return out.join('\n');
}

/** Groups notes by file in reading order; questions about the whole change come last. */
function byFile(notes: ResolvedAnnotation[]): [string, ResolvedAnnotation[]][] {
  const groups = new Map<string, ResolvedAnnotation[]>();
  for (const a of notes) {
    const list = groups.get(a.file) ?? [];
    list.push(a);
    groups.set(a.file, list);
  }
  return [...groups].sort(([a], [b]) => Number(!a) - Number(!b));
}

/** What `review` answers: the change, its summary and an index of the notes. */
export function reviewIndex(l: LoadedReview): string {
  const { review, target, notes } = l;
  const out = [header(l), '', '## Summary of the change'];
  if (review.overview) {
    if (review.overviewOf !== diffDigest(target)) {
      out.push('_Out of date: written for an earlier state of the change._', '');
    }
    out.push(summaryMarkdown(review.overview.trim()));
  } else {
    out.push('None yet.');
  }
  out.push('', `## Notes (${notes.length})`);
  if (!notes.length) {
    out.push('None yet.');
    return out.join('\n');
  }
  out.push('Call `notes` with a file or note ids for their full text and follow-up questions.');
  for (const [file, list] of byFile(notes)) {
    out.push('', `### ${file || 'Questions about the whole change'}`);
    for (const a of list) {
      const extra = [
        followUps(a) ? plural(followUps(a), 'follow-up question') : undefined,
        state(a),
        `id ${a.id}`,
      ].filter(Boolean);
      const where = a.file ? `${lines(a)}: ` : '';
      out.push(`- [${KIND_LABELS[a.kind]}] ${where}${a.title} (${extra.join(', ')})`);
    }
  }
  return out.join('\n');
}

function message(m: ThreadMessage, file: string): string {
  const who =
    m.from === 'ai'
      ? m.origin === 'chat'
        ? 'Claude Code chat'
        : 'Review Desk'
      : m.author
        ? `${m.author} (GitHub)`
        : 'Reviewer';
  const s = m.selection;
  const about = s
    ? ` (about ${s.file !== file ? `${s.file} ` : ''}${s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}-${s.endLine}`})`
    : '';
  return `**${who}**${about}:\n${m.body.trim()}`;
}

function note(a: ResolvedAnnotation): string {
  const where = a.file ? `${a.file}, ${lines(a)}` : 'About the whole change';
  const from = a.origin === 'chat' ? ' · from the Claude Code chat' : '';
  const out = [`## [${KIND_LABELS[a.kind]}] ${a.title}`, `${where} · id ${a.id}${from}`];
  const s = state(a);
  if (s) out.push(`_${s[0].toUpperCase()}${s.slice(1)}._`);
  if (a.body.trim()) out.push('', a.body.trim());
  if (a.thread?.length) {
    out.push('', '### Follow-up questions', ...a.thread.map((m) => '\n' + message(m, a.file)));
  }
  return out.join('\n');
}

/** Whether `file` names `path`: the same path, its end, or its file name. */
function sameFile(file: string, query: string): boolean {
  const q = query.replace(/\\/g, '/').replace(/^\.?\//, '');
  return file === q || file.endsWith(`/${q}`) || path.posix.basename(file) === q;
}

/** What `notes` answers: the full notes on one file, or with the given ids (all without either). */
export function noteDetails(l: LoadedReview, query: { file?: string; ids?: string[] }): string {
  let picked = l.notes;
  const missing: string[] = [];
  if (query.ids?.length) {
    picked = query.ids.flatMap((id) => {
      const a = l.notes.find((n) => n.id === id);
      if (!a) missing.push(id);
      return a ? [a] : [];
    });
  } else if (query.file) {
    picked = l.notes.filter((a) => a.file && sameFile(a.file, query.file!));
    if (!picked.length) {
      const files = [...new Set(l.notes.map((a) => a.file).filter(Boolean))];
      return `No notes on ${query.file}.${files.length ? ` Files with notes: ${files.join(', ')}.` : ''}`;
    }
  }
  if (!picked.length)
    return missing.length ? `No notes with ids ${missing.join(', ')}.` : 'No notes yet.';

  const out: string[] = [];
  let size = 0;
  let shown = 0;
  for (const a of picked) {
    const text = note(a);
    if (shown && size + text.length > MAX_NOTES_CHARS) break;
    out.push(text);
    size += text.length;
    shown++;
  }
  const left = picked.slice(shown);
  if (left.length) {
    out.push(
      `${plural(left.length, 'more note')} left out for length: ${left.map((a) => a.id).join(', ')}. Ask for them by id.`,
    );
  }
  if (missing.length) out.push(`No notes with ids ${missing.join(', ')}.`);
  return out.join('\n\n');
}
