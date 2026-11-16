import type { DiffFile, DiffLine, Side } from './diffParser';

/** A run of added and deleted lines inside a hunk: what a change handle explains. */
export interface ChangeBlock {
  /** Working tree lines the handle covers; for a pure deletion, the line after it. */
  newStart: number;
  newEnd: number;
  /** The lines to explain: the added lines, or the deleted ones when nothing was added. */
  side: Side;
  start: number;
  end: number;
  added: number;
  deleted: string[];
}

/** The runs of added and deleted lines of a file, one per change block, in order. */
export function changeRuns(file: DiffFile): { added: DiffLine[]; deleted: DiffLine[] }[] {
  const runs: { added: DiffLine[]; deleted: DiffLine[] }[] = [];
  for (const hunk of file.hunks) {
    let i = 0;
    while (i < hunk.lines.length) {
      if (hunk.lines[i].kind === 'context') {
        i++;
        continue;
      }
      const run: DiffLine[] = [];
      while (i < hunk.lines.length && hunk.lines[i].kind !== 'context') run.push(hunk.lines[i++]);
      runs.push({
        added: run.filter((l) => l.kind === 'add'),
        deleted: run.filter((l) => l.kind === 'del'),
      });
    }
  }
  return runs;
}

/** The change blocks of a file, in order. Binary files have none. */
export function changeBlocks(file: DiffFile): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  for (const hunk of file.hunks) {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === 'context') {
        i++;
        continue;
      }
      const run = [];
      while (i < lines.length && lines[i].kind !== 'context') run.push(lines[i++]);
      const added = run.filter((l) => l.kind === 'add').map((l) => l.newLine!);
      const deleted = run.filter((l) => l.kind === 'del');
      if (added.length) {
        const start = Math.min(...added);
        const end = Math.max(...added);
        blocks.push({
          newStart: start,
          newEnd: end,
          side: 'new',
          start,
          end,
          added: added.length,
          deleted: deleted.map((l) => l.text),
        });
      } else {
        // A pure deletion sits before the next line of the new file (or after the last one).
        const next = lines.slice(i).find((l) => l.newLine !== null)?.newLine;
        const prev = [...lines.slice(0, i)].reverse().find((l) => l.newLine !== null)?.newLine;
        const at = next ?? prev ?? 1;
        blocks.push({
          newStart: at,
          newEnd: at,
          side: 'old',
          start: deleted[0].oldLine!,
          end: deleted[deleted.length - 1].oldLine!,
          added: 0,
          deleted: deleted.map((l) => l.text),
        });
      }
    }
  }
  return blocks;
}
