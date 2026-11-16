import type { PanelState, SummaryRun } from '../src/shared/protocol';
import type { Translation } from './common';
import { splitSummary } from '../src/shared/summary';
import { FileLinkedMarkdown } from './linked';
import { Flow, ReadingOrder } from './summaryParts';
import { post } from './vscode';

/**
 * The summary of the whole change, above the notes: a button until one is written, then the
 * text (streaming while Claude writes it) with Update to write it again.
 */
export function Summary(props: {
  state: PanelState;
  run: SummaryRun | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** The summary being translated, or why that failed. */
  translation?: Translation;
}) {
  const { state, run, open, onToggle, translation } = props;
  if (!state.files.length && !state.overview) return null;
  const writing = !!run && !run.done;
  const text = writing ? run.text : state.overview;
  const files = `${state.files.length} ${state.files.length === 1 ? 'file' : 'files'}`;
  // Buttons in the <summary> row must not also fold the section.
  const act = (msg: 'summarize' | 'cancelSummary') => (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    post({ type: msg });
  };

  if (!text && !writing) {
    return (
      <div class="summary invite" id="summary">
        <div class="summary-row">
          <span class="summary-title">Summary</span>
          <span class="dim">What changed across {files}</span>
          <button class="primary" onClick={act('summarize')}>
            {run?.error ? 'Retry' : '✦ Summarize changes'}
          </button>
        </div>
        {run?.error && <div class="error">{run.error}</div>}
      </div>
    );
  }
  return (
    <details
      class="summary"
      id="summary"
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class="summary-row">
        <span class="summary-title">Summary</span>
        {writing ? (
          <span class="live">
            <span class="dot" /> writing
          </span>
        ) : (
          <span class="dim">
            {files}
            {state.overviewStale && <span class="warn"> · out of date</span>}
          </span>
        )}
        {!writing && (translation?.running || state.overviewTranslatable) && (
          <button
            class="translate"
            disabled={translation?.running}
            title={`Translate the summary into ${state.language} (its diagram and files stay as they are)`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              post({ type: 'translate', id: '#summary' });
            }}
          >
            🌐 {translation?.running ? 'Translating…' : `Translate to ${state.language}`}
          </button>
        )}
        {writing ? (
          <button onClick={act('cancelSummary')}>Cancel</button>
        ) : (
          <button
            class={state.overviewStale ? 'primary' : ''}
            title="Write the summary again for the changes as they are now"
            onClick={act('summarize')}
          >
            Update
          </button>
        )}
      </summary>
      {text ? (
        <SummaryBody text={text} writing={writing} state={state} />
      ) : (
        <div class="dim">Claude is reading the change…</div>
      )}
      {run?.error && <div class="error">{run.error}</div>}
      {translation?.error && <div class="error">Translation failed: {translation.error}</div>}
    </details>
  );
}

/** The summary's text, then the flow it draws and the order it suggests reading the change in. */
function SummaryBody(props: { text: string; writing: boolean; state: PanelState }) {
  const { text, writing, state } = props;
  const parts = splitSummary(text);
  return (
    <>
      {parts.text && <FileLinkedMarkdown text={parts.text} files={state.files} />}
      {(parts.diagram || parts.writing === 'diagram') && (
        <Flow code={parts.diagram} writing={writing && parts.writing === 'diagram'} />
      )}
      {(parts.order || parts.orderError || parts.writing === 'order') && (
        <ReadingOrder
          steps={parts.order}
          error={parts.orderError}
          writing={writing && parts.writing === 'order'}
          files={state.files}
          viewed={state.viewed ?? {}}
        />
      )}
    </>
  );
}
