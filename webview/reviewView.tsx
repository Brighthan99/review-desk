import type { JSX } from 'preact';
import type { CardView, PanelState } from '../src/shared/protocol';
import { type Filter, KIND_ORDER, KIND_NAMES, EXPLAIN_HINT, basename } from './common';
import { SummarizeFile, FileSection, Empty } from './fileView';

export function ReviewView(props: {
  state: PanelState;
  summary: JSX.Element;
  shown: CardView[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  hideResolved: boolean;
  onHideResolved: (hide: boolean) => void;
  currentFile: string | null;
  renderCard: (c: CardView) => JSX.Element;
}) {
  const { state, summary, shown, filter, onFilter, hideResolved, onHideResolved } = props;
  const { currentFile, renderCard } = props;
  const all = state.cards;
  // The file the reviewer is on: its section is marked, or stands alone while it has no notes.
  const onCurrent = all.some((c) => c.file === currentFile);
  const fileSection = currentFile && !onCurrent && (
    <FileSection file={currentFile} changed={state.files.includes(currentFile)} />
  );
  if (!all.length) {
    return (
      <>
        {summary}
        {fileSection}
        <Empty title="No notes yet" hint={EXPLAIN_HINT} />
      </>
    );
  }
  const kinds = KIND_ORDER.filter((k) => all.some((c) => c.kind === k));
  const understood = all.filter((c) => c.understood).length;
  const resolved = all.filter((c) => c.resolved).length;
  const groups: [string, CardView[]][] = [];
  for (const c of shown) {
    const name = c.group ?? 'Other';
    const g = groups.find(([n]) => n === name);
    if (g) g[1].push(c);
    else groups.push([name, [c]]);
  }
  const currentGroup = groups.find(([, cards]) => cards.some((c) => c.file === currentFile))?.[0];
  const summarized = all.some(
    (c) => c.file === currentFile && c.startLine === 0 && c.kind !== 'question',
  );
  return (
    <>
      {summary}
      {fileSection}
      <div class="filters">
        <button class={filter === 'all' ? 'on' : ''} onClick={() => onFilter('all')}>
          All {all.length}
        </button>
        {kinds.map((k) => (
          <button key={k} class={`${filter === k ? 'on' : ''} k-${k}`} onClick={() => onFilter(k)}>
            {KIND_NAMES[k]} {all.filter((c) => c.kind === k).length}
          </button>
        ))}
        {resolved > 0 && (
          <button
            class={`hide-resolved${hideResolved ? ' on' : ''}`}
            aria-pressed={hideResolved}
            title={
              hideResolved
                ? 'Show the notes whose GitHub thread is resolved again'
                : 'Hide the notes whose GitHub thread is resolved'
            }
            onClick={() => onHideResolved(!hideResolved)}
          >
            ✓ Hide Resolved {resolved}
          </button>
        )}
        <span class="progress">
          {understood} / {all.length} understood
          <span class="bar">
            <i style={{ width: `${(understood / all.length) * 100}%` }} />
          </span>
        </span>
      </div>
      {groups.map(([name, cards], i) => {
        const current = name === currentGroup;
        return (
          <div
            class={`group${current ? ' current' : ''}`}
            key={name}
            id={current ? 'file-section' : undefined}
          >
            <div class="group-head">
              <span>
                <em>{i + 1}</em> {name}
                <span class="dim">
                  {' '}
                  ·{' '}
                  {[
                    ...new Set(cards.map((c) => (c.file ? basename(c.file) : 'whole change'))),
                  ].join(', ')}
                </span>
              </span>
              {current && !summarized && <SummarizeFile file={currentFile!} />}
            </div>
            {cards.map(renderCard)}
          </div>
        );
      })}
    </>
  );
}
