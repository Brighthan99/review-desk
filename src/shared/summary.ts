// The parts of a summary of the whole change: its text, a flow diagram (mermaid) and the
// order to read the change in, which Claude writes as fenced blocks at the end. Shared by the
// extension (the list in reading order) and the panel.

/** A step of the reading order: related changes, read together. */
export interface ReadingStep {
  title: string;
  why?: string;
  files: ReadingFile[];
}

/** A file of a step, with the part that matters when one is named. */
export interface ReadingFile {
  file: string;
  start?: number;
  end?: number;
}

/** Info string of the fenced block holding the reading order (JSON). */
export const ORDER_BLOCK = 'review-desk-order';
export const DIAGRAM_BLOCK = 'mermaid';

export interface SummaryParts {
  /** The summary itself (markdown), without the diagram and the reading order. */
  text: string;
  /** Mermaid source of the flow the change adds or alters. */
  diagram?: string;
  order?: ReadingStep[];
  /** Why the reading order could not be read, when its block is there but broken. */
  orderError?: string;
  /** The block being written while the summary streams in. */
  writing?: 'diagram' | 'order';
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w-]+)?[^\n]*$/gm;

/** Splits a summary into its text, diagram and reading order (also while it streams in). */
export function splitSummary(markdown: string): SummaryParts {
  const parts: SummaryParts = { text: markdown };
  const cuts: [number, number][] = [];
  FENCE.lastIndex = 0;
  for (let open = FENCE.exec(markdown); open; open = FENCE.exec(markdown)) {
    const [line, fence, info] = open;
    const kind = info === DIAGRAM_BLOCK ? 'diagram' : info === ORDER_BLOCK ? 'order' : undefined;
    const bodyStart = open.index + line.length + 1;
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`, 'm');
    const rest = markdown.slice(bodyStart);
    const end = close.exec(rest);
    if (!kind) {
      // Another code block: skip past it, fences inside it are code.
      if (!end) break;
      FENCE.lastIndex = bodyStart + end.index + end[0].length;
      continue;
    }
    if (!end) {
      parts.writing = kind;
      cuts.push([headingBefore(markdown, open.index), markdown.length]);
      break;
    }
    const body = rest.slice(0, end.index).trim();
    if (kind === 'diagram') parts.diagram = body;
    else {
      const read = readOrder(body);
      if (Array.isArray(read)) parts.order = read;
      else parts.orderError = read.error;
    }
    const after = bodyStart + end.index + end[0].length;
    cuts.push([headingBefore(markdown, open.index), after]);
    FENCE.lastIndex = after;
  }
  let text = markdown;
  for (const [from, to] of cuts.reverse()) text = text.slice(0, from) + text.slice(to);
  parts.text = text.replace(/\n{3,}/g, '\n\n').trim();
  return parts;
}

/** Where a block starts, taking a heading right above it along (the panel has its own). */
function headingBefore(markdown: string, index: number): number {
  const before = markdown.slice(0, index).replace(/\s+$/, '');
  const lineStart = before.lastIndexOf('\n') + 1;
  return /^ {0,3}#{1,6}\s/.test(before.slice(lineStart)) ? lineStart : index;
}

/** The reading order from its JSON, as lenient as it can be about the shape. */
export function readOrder(json: string): ReadingStep[] | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return {
      error: `The reading order is not valid JSON (${e instanceof Error ? e.message : e}).`,
    };
  }
  if (!Array.isArray(data)) return { error: 'The reading order is not a list of steps.' };
  const steps: ReadingStep[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const files = (Array.isArray(o.files) ? o.files : [])
      .filter((f): f is string => typeof f === 'string')
      .map(readFile)
      .filter((f): f is ReadingFile => !!f);
    if (!title && !files.length) continue;
    steps.push({
      title: title || files[0].file,
      why: typeof o.why === 'string' && o.why.trim() ? o.why.trim() : undefined,
      files,
    });
  }
  return steps.length ? steps : { error: 'The reading order has no steps.' };
}

/** `path`, `path:12` or `path:12-40` (backticks and ./ dropped). */
export function readFile(text: string): ReadingFile | undefined {
  const m = /^`?(?:\.\/)?([^\s`:]+?)(?::(\d+)(?:\s*[-–]\s*(\d+))?)?`?$/.exec(text.trim());
  if (!m) return undefined;
  const start = m[2] ? Number(m[2]) : undefined;
  const end = m[3] ? Number(m[3]) : start;
  return { file: m[1], start, end: start !== undefined && end! < start ? start : end };
}

/**
 * The summary as plain markdown for other readers (a pull request review, the Claude Code
 * chat): its text, the diagram as a mermaid block (GitHub draws it), the reading order as a
 * numbered list.
 */
export function summaryMarkdown(markdown: string, options: { diagram?: boolean } = {}): string {
  const parts = splitSummary(markdown);
  const out = [parts.text];
  if (parts.diagram && options.diagram !== false)
    out.push(`\`\`\`${DIAGRAM_BLOCK}\n${parts.diagram}\n\`\`\``);
  if (parts.order) {
    out.push(
      ['**Reading order**', '']
        .concat(
          parts.order.map((s, i) => {
            const files = s.files
              .map(
                (f) =>
                  `\`${f.file}${f.start ? `:${f.start}${f.end !== f.start ? `-${f.end}` : ''}` : ''}\``,
              )
              .join(', ');
            return `${i + 1}. **${s.title}**${s.why ? ` — ${s.why}` : ''}${files ? ` (${files})` : ''}`;
          }),
        )
        .join('\n'),
    );
  }
  return out.filter(Boolean).join('\n\n');
}
