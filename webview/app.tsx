import { agentLabel, agentTooltip } from '../src/shared/agentUse';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  ActiveFileInfo,
  CitationView,
  CardView,
  CommentTarget,
  GithubCheck,
  PanelState,
  SelectionRef,
  SummaryRun,
  ToPanel,
} from '../src/shared/protocol';
import { Card, Ask } from './cards';
import {
  type Answer,
  type Filter,
  type Translation,
  EXPLAIN_HINT,
  basename,
  Links,
  lines,
} from './common';
import { FileView, Empty } from './fileView';
import { ReviewView } from './reviewView';
import { Summary } from './summary';
import { loadState, post, saveState } from './vscode';

const BOTTOM = '__bottom';
/** The box below in PR Comment mode keeps its own draft. */
const COMMENT = '__comment';

export function App() {
  const saved = loadState();
  const [state, setState] = useState<PanelState | null | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [explains, setExplains] = useState<Record<string, Answer>>({});
  // Notes being translated, or whose translation failed (why).
  const [translations, setTranslations] = useState<Record<string, Translation>>({});
  const [selection, setSelection] = useState<SelectionRef | null>(null);
  const [useSelection, setUseSelection] = useState(true);
  const [activeFile, setActiveFile] = useState<ActiveFileInfo | null>(null);
  const [filter, setFilter] = useState<Filter>((saved.filter as Filter) ?? 'all');
  // Notes whose GitHub thread is resolved, left out of the list (the open one still shows).
  const [hideResolved, setHideResolved] = useState(saved.hideResolved ?? false);
  const [drafts, setDrafts] = useState<Record<string, string>>(saved.drafts ?? {});
  const [summary, setSummary] = useState<SummaryRun | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(saved.summaryOpen ?? true);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [citations, setCitations] = useState<Record<string, CitationView>>({});
  // The bottom box asks about the current file; × switches it to the whole change until
  // another file is picked.
  const [askWhole, setAskWhole] = useState(false);
  // The box below: a question for Claude, or a PR comment for the author, drafted by Claude.
  const [mode, setMode] = useState<'ask' | 'comment'>('ask');
  // Lines picked for a PR comment the editor selection does not show (deleted lines).
  const [composing, setComposing] = useState<CommentTarget | null>(null);
  // When GitHub was last read for the pull request's replies, or that it is being read.
  const [githubCheck, setGithubCheck] = useState<GithubCheck | null>(null);
  // Bumped by each focus request, so asking for the active card again still scrolls to it.
  const [focusTick, setFocusTick] = useState(0);
  const scrolledTo = useRef('');
  const askRef = useRef<HTMLTextAreaElement>(null);
  const stateRef = useRef<PanelState | null | undefined>(undefined);

  useEffect(
    () => saveState({ filter, hideResolved, drafts, summaryOpen }),
    [filter, hideResolved, drafts, summaryOpen],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent<ToPanel>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'state':
          stateRef.current = msg.state;
          setState(msg.state);
          // Finished answers now live in the card threads.
          setAnswers((a) =>
            Object.fromEntries(Object.entries(a).filter(([, v]) => !v.done || v.error)),
          );
          // Finished explanations now live in their cards.
          setExplains((x) =>
            Object.fromEntries(
              Object.entries(x).filter(
                ([id, v]) =>
                  !v.done || v.error || msg.state?.cards.some((c) => c.id === id && c.pending),
              ),
            ),
          );
          break;
        case 'explain':
          setExplains((x) => ({
            ...x,
            [msg.cardId]: { text: msg.text, done: msg.done, error: msg.error },
          }));
          break;
        case 'githubCheck':
          setGithubCheck(msg.check);
          break;
        case 'translation':
          setTranslations((t) => {
            const next = { ...t };
            if (msg.running || msg.error)
              next[msg.cardId] = { running: msg.running, error: msg.error };
            else delete next[msg.cardId];
            return next;
          });
          break;
        case 'focus':
          setActiveId(msg.id);
          setFocusTick((t) => t + 1);
          break;
        case 'answer': {
          const card = stateRef.current?.cards.find((c) => c.id === msg.cardId);
          const last = card?.thread[card.thread.length - 1];
          const alreadyInThread =
            msg.done && !msg.error && last?.from === 'ai' && last.body === msg.text;
          setAnswers((a) => {
            const next = { ...a };
            if (alreadyInThread) delete next[msg.cardId];
            else next[msg.cardId] = { text: msg.text, done: msg.done, error: msg.error };
            return next;
          });
          break;
        }
        case 'selection':
          setSelection(msg.selection);
          if (msg.selection) setUseSelection(true);
          break;
        case 'activeFile':
          setActiveFile(msg.info);
          break;
        case 'focusAsk':
          setMode('ask');
          setTimeout(() => askRef.current?.focus());
          break;
        case 'compose':
          setComposing(msg.target);
          if (msg.focus) {
            setMode('comment');
            setTimeout(() => askRef.current?.focus());
          }
          break;
        case 'summary':
          setSummary(msg.run);
          break;
        case 'citations':
          setCitations(msg.map);
          break;
        case 'focusSummary':
          setSummaryOpen(true);
          setTimeout(() => document.getElementById('summary')?.scrollIntoView({ block: 'start' }));
          break;
        case 'currentFile':
          setCurrentFile(msg.file);
          setAskWhole(false);
          if (msg.focus) {
            // Picked in the list: show the whole section, not the card that was open.
            setFilter('all');
            setActiveId(null);
            setTimeout(() => showSection(document.getElementById('file-section')));
          }
          break;
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Scrolls to a card once when it becomes active (or when it shows up, if the focus came
  // first). Later state updates, such as a reload after any file change, leave the scroll alone.
  useEffect(() => {
    const key = `${activeId}:${focusTick}`;
    if (!activeId || scrolledTo.current === key) return;
    const el = document.getElementById(`card-${activeId}`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    scrolledTo.current = key;
  }, [activeId, focusTick, state]);

  if (state === undefined) return <div class="empty">Loading…</div>;
  if (state === null) {
    return (
      <Empty
        title="No review is open"
        hint={`Start a review of the current branch, or ${EXPLAIN_HINT.charAt(0).toLowerCase()}${EXPLAIN_HINT.slice(1)} A review starts on its own.`}
      >
        <button class="primary" onClick={() => post({ type: 'start' })}>
          Start Review
        </button>
      </Empty>
    );
  }

  const setDraft = (key: string, text: string) => setDrafts((d) => ({ ...d, [key]: text }));
  const select = (id: string) => {
    setActiveId(id);
    post({ type: 'select', id });
  };
  // The head of the open card closes it; of another card, opens that one at its code.
  const toggle = (id: string) => {
    if (id !== activeId) return select(id);
    setActiveId(null);
    post({ type: 'close', id });
  };
  const onSelection = !!selection && useSelection;
  const askFile = !onSelection && !askWhole ? currentFile : null;
  const ask = (cardId: string | null, text: string) => {
    post({
      type: 'ask',
      cardId,
      text,
      useSelection: cardId === null && onSelection,
      file: cardId === null ? (askFile ?? undefined) : undefined,
    });
    setDraft(cardId ?? BOTTOM, '');
  };

  // A PR comment goes on the lines picked for it, else on the lines selected in the editor.
  const commentOn: CommentTarget | null =
    composing ?? (selection ? { ...selection, side: 'new' } : null);
  const draftComment = (text: string) => {
    if (!commentOn) return;
    post({ type: 'draftComment', target: commentOn, request: text });
    setDraft(COMMENT, '');
  };

  const shown = state.cards.filter(
    (c) =>
      (filter === 'all' || c.kind === filter) &&
      (!hideResolved || !c.resolved || c.id === activeId),
  );
  const cardProps = (card: CardView) => ({
    card,
    files: state.files,
    canPost: !!state.pr,
    active: card.id === activeId,
    answer: answers[card.id],
    explain: explains[card.id],
    replyRun: explains[`reply:${card.id}`],
    translation: translations[card.id],
    language: state.language,
    draft: drafts[card.id] ?? '',
    onDraft: (t: string) => setDraft(card.id, t),
    onSelect: () => select(card.id),
    onToggle: () => toggle(card.id),
    onAsk: (t: string) => ask(card.id, t),
    onNext: () => {
      const i = shown.findIndex((c) => c.id === card.id);
      if (i >= 0 && i < shown.length - 1) select(shown[i + 1].id);
    },
  });

  return (
    <Links.Provider value={{ files: state.files, citations }}>
      <div class="app">
        <Header
          state={state}
          check={githubCheck}
          writing={
            state.cards.filter((c) => c.pending && explains[c.id] && !explains[c.id].done).length
          }
        />
        <main class="list">
          {activeFile ? (
            <FileView
              info={activeFile}
              cards={state.cards}
              activeId={activeId}
              renderCard={(c) => <Card key={c.id} {...cardProps(c)} />}
            />
          ) : (
            <ReviewView
              state={state}
              summary={
                <Summary
                  state={state}
                  run={summary}
                  open={summaryOpen}
                  onToggle={setSummaryOpen}
                  translation={translations['#summary']}
                />
              }
              shown={shown}
              filter={filter}
              onFilter={setFilter}
              hideResolved={hideResolved}
              onHideResolved={setHideResolved}
              currentFile={currentFile}
              renderCard={(c) => <Card key={c.id} {...cardProps(c)} />}
            />
          )}
        </main>
        <footer class="askbar">
          <div class="modes" role="tablist">
            <button
              role="tab"
              aria-selected={mode === 'ask'}
              class={mode === 'ask' ? 'on' : ''}
              title="Ask Claude about the code: the answer is for you"
              onClick={() => setMode('ask')}
            >
              Ask
            </button>
            <button
              role="tab"
              aria-selected={mode === 'comment'}
              class={`k-comment${mode === 'comment' ? ' on' : ''}`}
              title="Have Claude draft a review comment for the pull request's author, to edit and post"
              onClick={() => setMode('comment')}
            >
              PR Comment
            </button>
          </div>
          {mode === 'comment' ? (
            <>
              <div class="target">
                Comment on{' '}
                {commentOn ? (
                  <span class="chip">
                    {basename(commentOn.file)} {lines(commentOn.startLine, commentOn.endLine)}
                    {commentOn.side === 'old' && ' (deleted lines)'}
                  </span>
                ) : (
                  <span class="chip dim">
                    select lines in the editor, or click Comment above a changed block
                  </span>
                )}
              </div>
              <Ask
                draft={drafts[COMMENT] ?? ''}
                onDraft={(t) => setDraft(COMMENT, t)}
                onSend={draftComment}
                placeholder="What should the comment say? Leave it empty and Claude finds what is worth pointing out."
                sendLabel="Draft"
                allowEmpty
                disabled={!commentOn}
                inputRef={askRef}
              />
            </>
          ) : (
            <>
              <div class="target">
                Ask about{' '}
                {selection && onSelection ? (
                  <span class="chip">
                    {basename(selection.file)} {lines(selection.startLine, selection.endLine)}{' '}
                    selected
                    <button
                      class="x"
                      title="Clear selection"
                      onClick={() => setUseSelection(false)}
                    >
                      ×
                    </button>
                  </span>
                ) : askFile ? (
                  <span class="chip" title={askFile}>
                    {basename(askFile)}
                    <button
                      class="x"
                      title="Ask about the whole change instead"
                      onClick={() => setAskWhole(true)}
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <span class="chip dim">the whole change</span>
                )}
              </div>
              <Ask
                draft={drafts[BOTTOM] ?? ''}
                onDraft={(t) => setDraft(BOTTOM, t)}
                onSend={(t) => ask(null, t)}
                placeholder={
                  askFile
                    ? 'Ask about this file or the selected code…'
                    : 'Ask about this change or the selected code…'
                }
                inputRef={askRef}
              />
            </>
          )}
        </footer>
      </div>
    </Links.Provider>
  );
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Scrolls to a section and flashes it, so the switch to another file is noticed. */
function showSection(el: HTMLElement | null): void {
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  // Restart the animation when the same section is picked again.
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true });
}

/** The extension's logo (media/logo-color.svg). */
function Logo() {
  return (
    <svg class="logo" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <rect x="3" y="3" width="3.2" height="18" rx="1.6" fill="#3f8ee8" />
      <g fill="#9aa4b2">
        <rect x="9" y="4" width="6" height="3" rx="1.5" />
        <rect x="9" y="10.5" width="4.5" height="3" rx="1.5" />
        <rect x="9" y="17" width="10" height="3" rx="1.5" />
      </g>
      <path
        fill="#f2b33d"
        d="M19 3.5C19.4 6.6 20.4 8.1 23 8.5C20.4 8.9 19.4 10.4 19 13.5C18.6 10.4 17.6 8.9 15 8.5C17.6 8.1 18.6 6.6 19 3.5Z"
      />
    </svg>
  );
}

/** "just now", "3 min ago", "2 h ago": how long since `at`. */
function ago(at: number, now: number): string {
  const min = Math.floor((now - at) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

/** The pull request's Sync button: reads its replies on GitHub now; says when it last did. */
function GithubSync({ check }: { check: GithubCheck | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const running = !!check?.running;
  return (
    <span class="gh-sync">
      <button
        disabled={running}
        title="Read this pull request on GitHub now: new replies to its review threads, and whether it was merged"
        onClick={() => post({ type: 'syncGithub' })}
      >
        {running ? '⟳ Syncing…' : '⟳ Sync'}
      </button>
      {check?.error ? (
        <span class="warn" title={check.error}>
          sync failed
        </span>
      ) : (
        check?.at !== undefined && (
          <span class="dim" title={new Date(check.at).toLocaleString()}>
            checked {ago(check.at, now)}
          </span>
        )
      )}
    </span>
  );
}

function Header({
  state,
  writing,
  check,
}: {
  state: PanelState;
  writing: number;
  check: GithubCheck | null;
}) {
  return (
    <header class="head">
      <div class="title">
        <Logo /> {state.base} <span class="dim">↔</span> {state.head}
      </div>
      {state.pr && (
        <div class="pr-line">
          <a class="pr" href={state.pr.url}>
            PR #{state.pr.number}
            {state.pr.title ? ` ${state.pr.title}` : ''}
          </a>
          <GithubSync check={check} />
        </div>
      )}
      <div class="meta">
        {state.cards.length} {state.cards.length === 1 ? 'note' : 'notes'} · at{' '}
        {state.headSha.slice(0, 7)}
        {state.uncommitted > 0 && ` + ${state.uncommitted} uncommitted`}
        {!!state.newReplies && (
          <span
            class="new-replies"
            title="Replies on GitHub you have not seen yet: open their notes"
          >
            {' · '}● {state.newReplies} new {state.newReplies === 1 ? 'reply' : 'replies'}
          </span>
        )}
        {writing > 0 && (
          <span class="live">
            <span class="dot" /> writing {writing > 1 ? writing : ''}
          </span>
        )}
        {state.agent && (
          <button
            class={`agent${state.agent.path ? '' : ' missing'}`}
            title={`${agentTooltip(state.agent)} Click to pick the agent.`}
            onClick={() => post({ type: 'chooseAgent' })}
          >
            {agentLabel(state.agent)}
          </button>
        )}
        <button
          class="lang"
          title="The language Claude writes notes and answers in. Click to change it."
          onClick={() => post({ type: 'changeLanguage' })}
        >
          🌐 {state.language}
        </button>
      </div>
      {state.error && <pre class="error">{state.error}</pre>}
    </header>
  );
}
