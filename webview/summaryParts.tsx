import { useEffect, useState } from 'preact/hooks';
import { fileNamed } from '../src/shared/fileNames';
import type { ReadingFile, ReadingStep } from '../src/shared/summary';
import { post } from './vscode';

interface Mermaid {
  initialize(config: object): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let loading: Promise<Mermaid> | undefined;
let drawn = 0;

/** Mermaid's script, added to the page the first time a diagram is drawn (it is large). */
function loadMermaid(): Promise<Mermaid> {
  const w = window as unknown as { mermaid?: Mermaid };
  if (w.mermaid) return Promise.resolve(w.mermaid);
  return (loading ??= new Promise<Mermaid>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = document.body.dataset.mermaid ?? '';
    // The page's scripts need its nonce (Content-Security-Policy).
    script.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '';
    script.onload = () => (w.mermaid ? resolve(w.mermaid) : reject(new Error('not loaded')));
    script.onerror = () => {
      loading = undefined;
      reject(new Error('could not load the diagram library'));
    };
    document.head.appendChild(script);
  }));
}

const isDark = () =>
  document.body.classList.contains('vscode-dark') ||
  document.body.classList.contains('vscode-high-contrast');

/** The flow the change adds or alters, drawn from Claude's mermaid source. */
export function Flow({ code, writing }: { code?: string; writing: boolean }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!code || writing) return;
    let live = true;
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: isDark() ? 'dark' : 'default',
          fontFamily: getComputedStyle(document.body).fontFamily,
        });
        const out = await mermaid.render(`review-desk-flow-${++drawn}`, code);
        if (!live) return;
        setSvg(out.svg);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [code, writing]);

  return (
    <details class="part flow" open>
      <summary class="part-row">
        <span class="part-title">Flow</span>
        <span class="dim">drawn by AI from the change · check it against the code</span>
      </summary>
      {writing || (!svg && !error) ? (
        <div class="dim">Drawing…</div>
      ) : error ? (
        <>
          <div class="warn">The diagram could not be drawn ({error}). Its source:</div>
          <pre class="flow-source">
            <code>{code}</code>
          </pre>
        </>
      ) : (
        <div class="flow-svg" dangerouslySetInnerHTML={{ __html: svg! }} />
      )}
    </details>
  );
}

const span = (f: ReadingFile) =>
  f.start ? `:${f.start}${f.end && f.end !== f.start ? `–${f.end}` : ''}` : '';

/** The order Claude suggests reading the change in, steps of related files. */
export function ReadingOrder(props: {
  steps?: ReadingStep[];
  error?: string;
  writing: boolean;
  files: string[];
  viewed: Record<string, 'viewed' | 'changed'>;
}) {
  const { steps = [], error, writing, files, viewed } = props;
  const showInList = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'showReadingOrder' });
  };
  return (
    <details class="part order" open>
      <summary class="part-row">
        <span class="part-title">Reading order</span>
        {steps.length > 0 && (
          <span class="dim">
            {steps.length} {steps.length === 1 ? 'step' : 'steps'} · suggested by AI
          </span>
        )}
        {steps.length > 0 && !writing && (
          <button title="Show the files in this order in the Review list" onClick={showInList}>
            Show in list
          </button>
        )}
      </summary>
      {writing && !steps.length && <div class="dim">Ordering the change…</div>}
      {error && <div class="warn">{error}</div>}
      <ol class="steps">
        {steps.map((s, i) => {
          const found = s.files.map((f) => ({ ...f, path: fileNamed(f.file, files) }));
          const done =
            found.length > 0 && found.every((f) => !f.path || viewed[f.path] === 'viewed');
          return (
            <li key={i} class={done ? 'done' : ''}>
              <div class="step-title">
                {done && <span class="mark viewed">✓ </span>}
                {s.title}
              </div>
              {s.why && <div class="dim">{s.why}</div>}
              <div class="step-files">
                {found.map((f) =>
                  f.path ? (
                    <button
                      class="file-link"
                      title={`Open ${f.path}${f.start ? ` at line ${f.start}` : ''}${viewed[f.path] === 'viewed' ? ' (viewed)' : viewed[f.path] === 'changed' ? ' (changed since viewed)' : ''}`}
                      onClick={() => post({ type: 'reveal', file: f.path!, line: f.start ?? 1 })}
                    >
                      {viewed[f.path] === 'viewed' && <span class="mark viewed">✓</span>}
                      {viewed[f.path] === 'changed' && <span class="mark changed">●</span>}
                      {f.path.slice(f.path.lastIndexOf('/') + 1)}
                      {span(f)}
                    </button>
                  ) : (
                    <span
                      class="bad-ref"
                      title={`Not a file of this change: ${f.file}. The AI may have named it wrongly.`}
                    >
                      ⚠ {f.file}
                      {span(f)}
                    </span>
                  ),
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
