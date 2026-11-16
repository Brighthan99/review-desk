// Parser for `git diff` unified output and the numbered text form given to agents.

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';
export type Side = 'old' | 'new';

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noNewlineAtEnd?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  similarity?: number;
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

/** The path a file is known by in the review: the new path, or the old one if deleted. */
export function filePath(file: DiffFile): string {
  return (file.newPath ?? file.oldPath)!;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split('\n');
  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const finish = () => {
    if (file) files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (line.startsWith('diff --git ')) {
      finish();
      const paths = splitHeaderPaths(line.slice('diff --git '.length));
      file = {
        oldPath: paths?.[0] ?? null,
        newPath: paths?.[1] ?? null,
        status: 'modified',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (!file) continue;
    const f: DiffFile = file;

    if (hunk) {
      const h: Hunk = hunk;
      const marker = line[0];
      if (marker === ' ' || (line === '' && i < lines.length - 1 && isInsideHunk(h))) {
        h.lines.push({
          kind: 'context',
          oldLine: oldLine++,
          newLine: newLine++,
          text: line.slice(1),
        });
        continue;
      }
      if (marker === '+') {
        h.lines.push({ kind: 'add', oldLine: null, newLine: newLine++, text: line.slice(1) });
        f.additions++;
        continue;
      }
      if (marker === '-') {
        h.lines.push({ kind: 'del', oldLine: oldLine++, newLine: null, text: line.slice(1) });
        f.deletions++;
        continue;
      }
      if (marker === '\\') {
        const last = h.lines[h.lines.length - 1];
        if (last) last.noNewlineAtEnd = true;
        continue;
      }
      hunk = null;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      const h: Hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5] ?? '',
        lines: [],
      };
      f.hunks.push(h);
      hunk = h;
      oldLine = h.oldStart;
      newLine = h.newStart;
      continue;
    }

    if (line.startsWith('new file mode')) {
      f.status = 'added';
      f.oldPath = null;
    } else if (line.startsWith('deleted file mode')) {
      f.status = 'deleted';
      f.newPath = null;
    } else if (line.startsWith('rename from ')) {
      f.status = 'renamed';
      f.oldPath = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      f.status = 'renamed';
      f.newPath = unquote(line.slice('rename to '.length));
    } else if (line.startsWith('similarity index ')) {
      f.similarity = parseInt(line.slice('similarity index '.length), 10);
    } else if (line.startsWith('--- ')) {
      const p = stripPrefix(unquote(fileName(line)), 'a/');
      if (p !== null && f.status !== 'added') f.oldPath = p;
    } else if (line.startsWith('+++ ')) {
      const p = stripPrefix(unquote(fileName(line)), 'b/');
      if (p !== null && f.status !== 'deleted') f.newPath = p;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      f.binary = true;
    }
  }
  finish();
  return files;
}

// A hunk is still open while it has fewer lines than its header announced.
function isInsideHunk(h: Hunk): boolean {
  let oldCount = 0;
  let newCount = 0;
  for (const l of h.lines) {
    if (l.kind !== 'add') oldCount++;
    if (l.kind !== 'del') newCount++;
  }
  return oldCount < h.oldLines || newCount < h.newLines;
}

/**
 * The name on a `---`/`+++` line. git ends it with a tab when the name holds a space (so a
 * patch tool can tell where it ends): not part of the name.
 */
function fileName(line: string): string {
  return line.slice(4).replace(/\t$/, '');
}

function stripPrefix(p: string, prefix: string): string | null {
  if (p === '/dev/null') return null;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

// `diff --git a/x b/x` header: only reliable when both sides are equal, which covers
// everything except renames (handled by `rename from/to`) and quoted paths.
function splitHeaderPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest);
    if (!m) return null;
    return [stripPrefix(unquote(m[1]), 'a/')!, stripPrefix(unquote(m[2]), 'b/')!];
  }
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && rest.startsWith('a/') && rest.slice(2 + len, 5 + len) === ' b/') {
    const a = rest.slice(2, 2 + len);
    const b = rest.slice(5 + len);
    if (a === b) return [a, b];
  }
  return null;
}

// Undo git's C-style quoting of unusual paths.
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[++i];
    if (next >= '0' && next <= '7') {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
      bytes.push(...Buffer.from(map[next] ?? next, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The 1-based line span a hunk covers on one side, or null if it covers none. */
export function hunkSpan(h: Hunk, side: Side): [number, number] | null {
  const start = side === 'new' ? h.newStart : h.oldStart;
  const count = side === 'new' ? h.newLines : h.oldLines;
  return count === 0 ? null : [start, start + count - 1];
}

export function describeFile(f: DiffFile): string {
  const counts = `+${f.additions} −${f.deletions}`;
  if (f.binary) return `${filePath(f)} (${f.status}, binary)`;
  if (f.status === 'renamed') {
    return `${f.newPath} (renamed from ${f.oldPath}${f.similarity !== undefined ? `, ${f.similarity}%` : ''}, ${counts})`;
  }
  return `${filePath(f)} (${f.status}, ${counts})`;
}

/**
 * Text form of the diff for agents. Every line carries its real line numbers so the
 * agent never has to count: left column = old (base) line, right column = new (head) line.
 */
export function formatForAgent(files: DiffFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(`## ${describeFile(f)}`);
    if (f.binary) {
      out.push('(binary file, no line content)', '');
      continue;
    }
    for (const h of f.hunks) {
      out.push(
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.section}`.trimEnd(),
      );
      for (const l of h.lines) {
        const oldNo = l.oldLine === null ? '' : String(l.oldLine);
        const newNo = l.newLine === null ? '' : String(l.newLine);
        const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
        out.push(`${oldNo.padStart(5)} ${newNo.padStart(5)} |${marker}${l.text}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}
