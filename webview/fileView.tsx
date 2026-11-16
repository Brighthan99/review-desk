import type { ComponentChildren, JSX } from 'preact';
import type { ActiveFileInfo, CardView } from '../src/shared/protocol';
import { EXPLAIN_KEY, EXPLAIN_HINT, basename } from './common';
import { post } from './vscode';

/** Asks for a summary of a whole file (a note on the file). */
export function SummarizeFile({ file }: { file: string }) {
  return (
    <button
      class="summarize-file"
      title={`Have Claude summarize ${file}`}
      onClick={() => post({ type: 'summarizeFile', file })}
    >
      ✦ Summarize file
    </button>
  );
}

/** The section of the file the reviewer is on, while it has no notes yet. */
export function FileSection({ file, changed }: { file: string; changed: boolean }) {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  return (
    <div class="group current file-section" id="file-section">
      <div class="group-head">
        <span>
          <b>{basename(file)}</b>
          <span class="dim">
            {dir && ` · ${dir}`}
            {changed ? ' · changed' : ' · not changed in this review'}
          </span>
        </span>
        <SummarizeFile file={file} />
      </div>
      <div class="dim">
        No notes on this file yet.{' '}
        {changed
          ? `Click inside a changed block (or select lines) and press ${EXPLAIN_KEY}.`
          : `Select lines and press ${EXPLAIN_KEY}.`}
      </div>
    </div>
  );
}

export function FileView(props: {
  info: ActiveFileInfo;
  cards: CardView[];
  activeId: string | null;
  renderCard: (c: CardView) => JSX.Element;
}) {
  const { info, cards, activeId, renderCard } = props;
  const back = cards.find((c) => c.id === activeId) ?? cards[0];
  const context = cards.filter((c) => c.file === info.file);
  const summarized = context.some((c) => c.startLine === 0 && c.kind !== 'question');
  const dir = info.file.includes('/') ? info.file.slice(0, info.file.lastIndexOf('/')) : '';
  return (
    <div class="file-view">
      {back && (
        <button class="back" onClick={() => post({ type: 'select', id: back.id })}>
          ← Back to notes · {back.number} / {cards.length} {back.title}
        </button>
      )}
      <div class="file-title">
        {basename(info.file)}
        {!summarized && <SummarizeFile file={info.file} />}
      </div>
      <div class="meta">
        <span class="tag">Not changed in this review</span> {dir}
      </div>
      <div class="uses">
        {info.uses === 'loading' ? (
          <div class="dim">Finding changes that use this file…</div>
        ) : info.uses.length === 0 ? (
          <div class="dim">No changed lines use this file.</div>
        ) : (
          <>
            <div class="uses-title">Changes that use this file · {info.uses.length}</div>
            {info.uses.map((u) => (
              <button
                key={`${u.file}:${u.line}`}
                class="use"
                onClick={() => post({ type: 'reveal', file: u.file, line: u.line })}
              >
                <span class="where">
                  {basename(u.file)} {u.line}
                </span>
                <code>{u.text}</code>
                {u.cardNumber !== undefined && <span class="badge small">{u.cardNumber}</span>}
              </button>
            ))}
          </>
        )}
      </div>
      {context.length > 0 ? (
        <>
          <div class="group-head">Notes on this file</div>
          {context.map(renderCard)}
        </>
      ) : (
        <div class="dim hint">{EXPLAIN_HINT}</div>
      )}
    </div>
  );
}

export function Empty(props: { title: string; hint: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <div class="empty-title">{props.title}</div>
      <div class="dim">{props.hint}</div>
      {props.children}
    </div>
  );
}
