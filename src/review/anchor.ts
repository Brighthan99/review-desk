import { hunkSpan, type DiffFile, type Side } from './diffParser';
import {
  isFileNote,
  sortAnnotations,
  type AnchorState,
  type Annotation,
  type ResolvedAnnotation,
} from './model';
import { fileDigest, findFile, readSide, type ReviewTarget } from './target';

export function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export interface AnchorResult {
  state: AnchorState;
  start: number;
  end: number;
}

/**
 * Whether a line tells its place apart: one with a word or number of a few characters. A
 * line like `}`, `);` or an empty one appears all over a file, so finding it elsewhere says
 * nothing about where the note's code went.
 */
export function distinctive(text: string): boolean {
  const t = normalize(text);
  return t.length >= 4 && /[\p{L}\p{N}]/u.test(t);
}

/**
 * Checks that `anchorText` is the text of `start` in `lines` (1-based). When it is not, a
 * distinctive line is looked for in the whole file, nearest first, and the range moves
 * there (lines added or removed above it, however many); one that is not (`}`) is not
 * moved: stale, rather than on the wrong `}`.
 */
export function resolveAnchor(
  lines: string[],
  start: number,
  end: number,
  anchorText: string,
): AnchorResult {
  const want = normalize(anchorText);
  const matches = (line: number) =>
    line >= 1 && line <= lines.length && normalize(lines[line - 1]) === want;

  if (matches(start)) return { state: 'ok', start, end };
  if (!distinctive(anchorText)) return { state: 'stale', start, end };
  const reach = Math.max(start, lines.length - start + 1);
  for (let d = 1; d <= reach; d++) {
    for (const candidate of [start - d, start + d]) {
      if (matches(candidate)) {
        const shift = candidate - start;
        return {
          state: 'moved',
          start: candidate,
          end: Math.min(Math.max(end + shift, candidate), lines.length),
        };
      }
    }
  }
  return { state: 'stale', start, end };
}

/** Lines near `around` that look like `anchorText`, for telling an agent where it probably meant. */
export function anchorCandidates(
  lines: string[],
  anchorText: string,
  around: number,
  window = 10,
): { line: number; text: string }[] {
  const want = normalize(anchorText);
  if (!want) return [];
  const found: { line: number; text: string; distance: number }[] = [];
  for (
    let line = Math.max(1, around - window);
    line <= Math.min(lines.length, around + window);
    line++
  ) {
    const text = normalize(lines[line - 1]);
    if (text && (text === want || text.includes(want) || want.includes(text))) {
      found.push({ line, text: lines[line - 1], distance: Math.abs(line - around) });
    }
  }
  return found
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(({ line, text }) => ({ line, text }));
}

/** Whether a line range touches any hunk of the file on the given side. */
export function rangeInDiff(file: DiffFile, side: Side, start: number, end: number): boolean {
  return file.hunks.some((h) => {
    const span = hunkSpan(h, side);
    return span !== null && start <= span[1] && end >= span[0];
  });
}

export type RangeProblem =
  | { code: 'FILE_NOT_IN_DIFF' }
  | { code: 'OUT_OF_DIFF' }
  | { code: 'BAD_RANGE' }
  | { code: 'BINARY_FILE' };

/** Structural checks that do not need file content. Context notes may point outside the diff. */
export function checkRange(target: ReviewTarget, a: Annotation): RangeProblem | null {
  if (!a.file && a.kind === 'question') return null;
  if (a.startLine < 1 || a.endLine < a.startLine) return { code: 'BAD_RANGE' };
  const file = findFile(target, a.file);
  if (!file) return a.kind === 'context' ? null : { code: 'FILE_NOT_IN_DIFF' };
  if (file.binary) return { code: 'BINARY_FILE' };
  if (a.kind === 'context') return null;
  if (a.side === 'new' && file.status === 'deleted') return { code: 'OUT_OF_DIFF' };
  if (a.side === 'old' && file.status === 'added') return { code: 'OUT_OF_DIFF' };
  return rangeInDiff(file, a.side, a.startLine, a.endLine) ? null : { code: 'OUT_OF_DIFF' };
}

/** Numbers every annotation in reading order and checks its anchor against the code. */
export async function resolveAnnotations(
  target: ReviewTarget,
  annotations: Annotation[],
): Promise<ResolvedAnnotation[]> {
  const cache = new Map<string, Promise<string[] | null>>();
  const content = (side: Side, path: string) => {
    const key = `${side}:${path}`;
    let p = cache.get(key);
    if (!p) {
      p = readSide(target, side, path);
      cache.set(key, p);
    }
    return p;
  };

  return Promise.all(
    sortAnnotations(annotations).map(async (a, i): Promise<ResolvedAnnotation> => {
      if (!a.file) {
        return { ...a, number: i + 1, state: 'ok', resolvedStart: 0, resolvedEnd: 0 };
      }
      const lines = await content(a.side, a.file);
      if (isFileNote(a)) {
        // Written for the file as it was: the anchor is the file's fingerprint.
        const same = !a.anchorText || a.anchorText === fileDigest(target, a.file, lines);
        return {
          ...a,
          number: i + 1,
          state: same ? 'ok' : 'stale',
          resolvedStart: 0,
          resolvedEnd: 0,
        };
      }
      const r = lines
        ? resolveAnchor(lines, a.startLine, a.endLine, a.anchorText)
        : { state: 'stale' as const, start: a.startLine, end: a.endLine };
      return { ...a, number: i + 1, state: r.state, resolvedStart: r.start, resolvedEnd: r.end };
    }),
  );
}
