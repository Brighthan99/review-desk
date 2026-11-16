import { useContext, useEffect, useRef } from 'preact/hooks';
import { fileNamed } from '../src/shared/fileNames';
import { Links } from './common';
import { Markdown } from './markdown';
import { post } from './vscode';

/**
 * Markdown whose `path` and `path:line` code spans open that file: a changed file, or any
 * file the extension found in the repository. A cited file or line that does not exist is
 * flagged instead (the AI named it wrongly).
 */
export function FileLinkedMarkdown({ text, files }: { text: string; files?: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const links = useContext(Links);
  useEffect(() => {
    for (const el of ref.current?.querySelectorAll<HTMLElement>('code') ?? []) {
      if (el.closest('pre')) continue;
      const span = (el.textContent ?? '').trim();
      const cited = links.citations[span];
      const link = cited?.file
        ? { file: cited.file, line: cited.line ?? 1 }
        : fileLink(span, files ?? links.files);
      if (cited?.problem) {
        el.classList.add('bad-ref');
        el.title = `⚠ ${cited.problem}`;
      }
      if (!link) continue;
      el.classList.add('file-link');
      el.dataset.file = link.file;
      el.dataset.line = String(link.line);
      if (!cited?.problem)
        el.title = `Open ${link.file}${link.line > 1 ? ` at line ${link.line}` : ''}`;
    }
  });
  const open = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('code.file-link');
    if (el) post({ type: 'reveal', file: el.dataset.file!, line: Number(el.dataset.line) });
  };
  return (
    <div ref={ref} onClick={open}>
      <Markdown text={text} />
    </div>
  );
}

/** A changed file named by `path`, `path:line` or `path:start-end` (a unique path suffix will do). */
function fileLink(text: string, files: string[]): { file: string; line: number } | undefined {
  const m = /^([^\s:]+?)(?::(\d+)(?:[-–]\d+)?)?$/.exec(text.trim());
  if (!m) return undefined;
  const file = fileNamed(m[1], files);
  return file ? { file, line: m[2] ? Number(m[2]) : 1 } : undefined;
}
