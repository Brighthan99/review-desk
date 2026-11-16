import { filesNamed } from '../shared/fileNames';
import { filePath } from './diffParser';
import { git } from './git';
import { readSide, type ReviewTarget } from './target';

/**
 * What a `path` or `path:line` written by the AI in a note or summary points at, or why it
 * points nowhere (no such file, a line past the file's end).
 */
export interface Citation {
  file?: string;
  line?: number;
  problem?: string;
}

/** Extensions that make a code span a file name even without a folder (`session.ts`). */
const FILE_EXT = new Set(
  (
    'ts tsx js jsx mjs cjs json jsonc md mdx py pyi go rs java kt kts swift m mm c h cc cpp cxx hpp cs rb php sh bash zsh ' +
    'yml yaml toml ini cfg conf sql html htm css scss sass less vue svelte xml gradle proto graphql gql lua dart scala ' +
    'ex exs erl hs tf txt lock env properties'
  ).split(' '),
);
/** path, path:line or path:start-end. */
const SPAN =
  /^(?:\.\/)?((?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.([A-Za-z0-9]+))(?::(\d+)(?:\s*[-–]\s*(\d+))?)?$/;

/** The code spans of markdown texts that name a file (fenced code left out). */
export function citedPaths(texts: string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    const prose = text.replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1[ \t]*$/gm, '');
    for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
      const span = m[1].trim();
      const p = SPAN.exec(span);
      if (p && (p[1].includes('/') || FILE_EXT.has(p[2].toLowerCase()))) out.add(span);
    }
  }
  return [...out];
}

/** A unique file of `list` by its path or a path suffix; 'many' when several end with it. */
function resolve(name: string, list: string[]): string | 'many' | undefined {
  const found = filesNamed(name, list);
  return found.length > 1 ? 'many' : found[0];
}

const checked = new WeakMap<ReviewTarget, Map<string, Citation>>();

/** Checks what each cited path points at, against the review's right side. */
export async function checkCitations(
  target: ReviewTarget,
  spans: string[],
): Promise<Record<string, Citation>> {
  let known = checked.get(target);
  if (!known) checked.set(target, (known = new Map()));
  const changed = target.files.map(filePath);
  let all: string[] | undefined;
  const files = async () =>
    (all ??= [
      ...changed,
      ...(
        await git(
          target.root,
          target.workTree
            ? ['ls-files', '-z']
            : ['ls-tree', '-r', '-z', '--name-only', target.head.sha],
        )
      )
        .split('\0')
        .filter(Boolean),
    ]);
  const out: Record<string, Citation> = {};
  for (const span of spans) {
    let c = known.get(span);
    if (!c) {
      c = await check(target, span, changed, files);
      known.set(span, c);
    }
    out[span] = c;
  }
  return out;
}

async function check(
  target: ReviewTarget,
  span: string,
  changed: string[],
  files: () => Promise<string[]>,
): Promise<Citation> {
  const p = SPAN.exec(span)!;
  const name = p[1];
  const start = p[3] ? Number(p[3]) : undefined;
  const end = p[4] ? Number(p[4]) : start;
  const file = resolve(name, changed) ?? resolve(name, await files());
  if (file === 'many') return {};
  if (!file)
    return { problem: `No file ${name} in the repository: the AI may have named it wrongly.` };
  if (!start) return { file };
  const lines = await readSide(target, 'new', file);
  if (lines && Math.max(start, end ?? start) > lines.length) {
    return {
      file,
      line: Math.min(start, lines.length),
      problem: `${file} has ${lines.length} lines: line ${Math.max(start, end ?? start)} is past its end.`,
    };
  }
  return { file, line: start };
}
