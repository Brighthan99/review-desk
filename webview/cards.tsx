import type { Ref } from 'preact';
import { useState } from 'preact/hooks';
import type { CardView, ThreadEntry } from '../src/shared/protocol';
import { parseComment } from '../src/shared/comment';
import { parseExplanation } from '../src/shared/explanation';
import { type Answer, type Translation, basename, lines, location } from './common';
import { FileLinkedMarkdown } from './linked';
import { Markdown } from './markdown';
import { post } from './vscode';

export function Card(props: {
  card: CardView;
  files: string[];
  /** The review is for a pull request: a PR comment can be posted. */
  canPost?: boolean;
  /** A reply to its GitHub thread being drafted by Claude. */
  replyRun?: Answer;
  active: boolean;
  answer?: Answer;
  explain?: Answer;
  translation?: Translation;
  /** The language notes and answers are written in now. */
  language: string;
  draft: string;
  onDraft: (t: string) => void;
  /** Goes to the card's code. */
  onSelect: () => void;
  /** Opens the card, or closes it when it is open. */
  onToggle: () => void;
  onAsk: (t: string) => void;
  onNext: () => void;
}) {
  const { card, files, active, answer, explain, translation, language } = props;
  if (card.kind === 'comment') return <CommentCard {...props} />;
  const { draft, onDraft, onSelect, onToggle, onAsk, onNext } = props;
  const wholeFile = !!card.file && card.startLine === 0;
  // A summary of a file outside the change still links to that file.
  const linkable = card.file && !files.includes(card.file) ? [...files, card.file] : files;
  const running = !!answer && !answer.done;
  // A requested explanation: streaming, failed, or interrupted (no state after a restart).
  const writing = card.pending && !!explain && !explain.done;
  const draftText =
    card.pending && explain?.text ? parseExplanation(explain.text, explain.done) : undefined;
  const title = card.pending
    ? draftText?.title || (writing ? 'Writing…' : 'No note yet')
    : card.title;
  const kind = draftText?.title ? draftText.kind : card.kind;
  return (
    <section
      id={`card-${card.id}`}
      class={`card k-${kind}${active ? ' active' : ''}${card.state === 'stale' ? ' stale' : ''}${card.pending ? ' pending' : ''}${card.resolved ? ' resolved' : ''}`}
    >
      <button
        class="card-head"
        onClick={onToggle}
        aria-expanded={active}
        title={active ? 'Close this note' : undefined}
      >
        <span class={`badge k-${kind}`}>{card.number}</span>
        <span class="card-title">{title}</span>
        {!!card.newReplies && (
          <span class="new-replies" title="New replies on GitHub">
            ● {card.newReplies} new
          </span>
        )}
        <span class="card-side">
          {running ? (
            <span class="live">
              <span class="dot" /> answering
            </span>
          ) : card.resolved ? (
            <Resolved card={card} />
          ) : card.understood ? (
            <span class="done">✓ Understood</span>
          ) : (
            location(card)
          )}
        </span>
      </button>
      {active && (
        <div class="card-body">
          <div class="meta">
            <span class={`kind k-${card.kind}`}>{card.kindLabel}</span> {location(card)}
            {card.side === 'old' && ' · base side'}
            {card.state === 'moved' && ' · moved'}
            {card.state === 'stale' && <span class="warn"> · outdated: the code changed</span>}
            {card.fromChat && ' · from the Claude Code chat'}
            {card.sourceUrl && (
              <>
                {' · '}
                <a href={card.sourceUrl}>View on GitHub</a>
              </>
            )}
            {card.resolved && ` · ${resolvedText(card)}`}
            {(translation?.running || card.translatable) && (
              <button
                class="translate"
                disabled={translation?.running}
                title={`Translate Claude's text in this note into ${language} (your questions stay as they are)`}
                onClick={() => post({ type: 'translate', id: card.id })}
              >
                🌐 {translation?.running ? 'Translating…' : `Translate to ${language}`}
              </button>
            )}
          </div>
          {translation?.error && <div class="error">Translation failed: {translation.error}</div>}
          {card.pending ? (
            <>
              {draftText?.body ? (
                <FileLinkedMarkdown text={draftText.body} files={linkable} />
              ) : (
                writing && (
                  <div class="dim">{explain.text ? '…' : 'Claude is reading the code…'}</div>
                )
              )}
              {explain?.error && <div class="error">{explain.error}</div>}
              <div class="actions">
                {writing ? (
                  <button onClick={() => post({ type: 'cancel', cardId: card.id })}>Cancel</button>
                ) : (
                  <button class="primary" onClick={() => post({ type: 'retry', id: card.id })}>
                    Retry
                  </button>
                )}
                <button onClick={() => post({ type: 'remove', id: card.id })}>Remove</button>
              </div>
            </>
          ) : (
            <>
              {card.body && <FileLinkedMarkdown text={card.body} files={linkable} />}
              <div class="actions">
                {wholeFile && card.state === 'stale' && (
                  <button
                    class="primary"
                    title="Summarize the file again as it is now"
                    onClick={() => post({ type: 'summarizeFile', file: card.file })}
                  >
                    Update
                  </button>
                )}
                <button
                  class={card.understood ? 'primary' : ''}
                  onClick={() => post({ type: 'understood', id: card.id, value: !card.understood })}
                >
                  {card.understood ? '✓ Understood' : 'Understood'}
                </button>
                <button onClick={onNext}>Next ↓</button>
                {card.file && <button onClick={onSelect}>Go to Code</button>}
                <button class="quiet" onClick={() => post({ type: 'remove', id: card.id })}>
                  Remove
                </button>
              </div>
              {(card.thread.length > 0 || answer) && (
                <Thread entries={card.thread} answer={answer} />
              )}
              {card.githubThread && (
                <GithubReply card={card} run={props.replyRun} asking={running} />
              )}
              <Ask
                draft={draft}
                onDraft={onDraft}
                onSend={onAsk}
                running={running}
                onCancel={() => post({ type: 'cancel', cardId: card.id })}
                placeholder="Ask a follow-up question…"
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Thread({ entries, answer }: { entries: ThreadEntry[]; answer?: Answer }) {
  return (
    <div class="thread">
      {entries.map((m, i) => (
        <Message
          key={i}
          from={m.from}
          author={m.author}
          body={m.body}
          note={
            [
              m.selection &&
                `${basename(m.selection.file)} ${lines(m.selection.startLine, m.selection.endLine)} selected`,
              m.origin === 'chat' && 'in the Claude Code chat',
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
        />
      ))}
      {answer && (
        <Message
          from="ai"
          body={answer.text || (answer.done ? '' : '…')}
          note={answer.error ? undefined : answer.done ? undefined : 'answering'}
          error={answer.error}
        />
      )}
    </div>
  );
}

function Message(props: {
  from: 'user' | 'ai';
  author?: string;
  body: string;
  note?: string;
  error?: string;
}) {
  const name = props.author ?? (props.from === 'user' ? 'You' : 'Claude');
  return (
    <div class={`msg ${props.from}${props.author ? ' other' : ''}`}>
      <span class="avatar">
        {props.author ? props.author.slice(0, 1).toUpperCase() : props.from === 'user' ? 'Y' : 'C'}
      </span>
      <div>
        <div class="who">
          {name}
          {props.note && <span class="dim"> · {props.note}</span>}
        </div>
        {props.body &&
          (props.from === 'ai' && !props.author ? (
            <FileLinkedMarkdown text={props.body} />
          ) : (
            <Markdown text={props.body} />
          ))}
        {props.error && <div class="error">{props.error}</div>}
      </div>
    </div>
  );
}

export function Ask(props: {
  draft: string;
  onDraft: (t: string) => void;
  onSend: (t: string) => void;
  placeholder: string;
  running?: boolean;
  onCancel?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** The button's label (Send by default). */
  sendLabel?: string;
  /** Sending with nothing typed is allowed (a PR comment Claude finds what to say in). */
  allowEmpty?: boolean;
  /** Nothing to send it about yet. */
  disabled?: boolean;
}) {
  const send = () => {
    const text = props.draft.trim();
    if ((text || props.allowEmpty) && !props.running && !props.disabled) props.onSend(text);
  };
  return (
    <div class="ask">
      <textarea
        ref={props.inputRef}
        rows={Math.min(6, Math.max(1, props.draft.split('\n').length))}
        value={props.draft}
        placeholder={props.placeholder}
        onInput={(e) => props.onDraft((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter starts a new line; Enter that ends an IME composition
          // (Korean, Japanese…) only finishes the word.
          if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          send();
        }}
      />
      {props.running ? (
        <button onClick={props.onCancel}>Cancel</button>
      ) : (
        <button
          class="primary"
          disabled={props.disabled || (!props.allowEmpty && !props.draft.trim())}
          onClick={send}
          title="Enter to send, Shift+Enter for a new line"
        >
          {props.sendLabel ?? 'Send'}
        </button>
      )}
    </div>
  );
}

/**
 * A PR comment: the text posted to the pull request, to post now, edit in place, or have
 * Claude rewrite (what is typed below it). Being written or rewritten, it shows as it streams.
 */
function CommentCard(props: Parameters<typeof Card>[0]) {
  const { card, files, active, explain, canPost, draft, onDraft, onSelect, onToggle, onAsk } =
    props;
  const [editing, setEditing] = useState<string | null>(null);
  const linkable = card.file && !files.includes(card.file) ? [...files, card.file] : files;
  // Written for the first time (pending), or rewritten: the new text as it comes.
  const writing = !!explain && !explain.done;
  const streamed = explain?.text ? parseComment(explain.text, explain.done) : undefined;
  const shownText = writing || card.pending ? (streamed?.body ?? '') : card.body;
  const title = card.pending
    ? streamed?.title || (writing ? 'Writing a PR comment…' : 'No comment yet')
    : writing && streamed?.title
      ? streamed.title
      : card.title;
  const posted = !!card.posted;
  return (
    <section
      id={`card-${card.id}`}
      class={`card k-comment${active ? ' active' : ''}${card.state === 'stale' ? ' stale' : ''}${card.pending ? ' pending' : ''}${card.resolved ? ' resolved' : ''}`}
    >
      <button
        class="card-head"
        onClick={onToggle}
        aria-expanded={active}
        title={active ? 'Close this comment' : undefined}
      >
        <span class="badge k-comment">{card.number}</span>
        <span class="card-title">{title}</span>
        {!!card.newReplies && (
          <span class="new-replies" title="New replies on GitHub">
            ● {card.newReplies} new
          </span>
        )}
        <span class="card-side">
          {writing ? (
            <span class="live">
              <span class="dot" /> writing
            </span>
          ) : card.resolved ? (
            <Resolved card={card} />
          ) : posted ? (
            <span class="done">✓ Posted</span>
          ) : (
            location(card)
          )}
        </span>
      </button>
      {active && (
        <div class="card-body">
          <div class="meta">
            <span class="kind k-comment">{card.kindLabel}</span> {location(card)}
            {card.side === 'old' && ' · base side'}
            {card.state === 'moved' && ' · moved'}
            {card.state === 'stale' && <span class="warn"> · outdated: the code changed</span>}
            {card.fromChat && ' · from the Claude Code chat'}
            {posted ? (
              <>
                {' · posted · '}
                <a href={card.posted}>View on GitHub</a>
                {card.resolved && ` · ${resolvedText(card)}`}
              </>
            ) : (
              !canPost && ' · not posted: this review is not for a pull request'
            )}
          </div>
          {editing !== null ? (
            <>
              <textarea
                class="comment-edit"
                rows={Math.min(24, editing.split('\n').length + 1)}
                value={editing}
                onInput={(e) => setEditing((e.target as HTMLTextAreaElement).value)}
              />
              <div class="actions">
                <button
                  class="primary"
                  disabled={!editing.trim()}
                  onClick={() => {
                    post({ type: 'editComment', id: card.id, body: editing });
                    setEditing(null);
                  }}
                >
                  Save
                </button>
                <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              {shownText ? (
                <FileLinkedMarkdown text={shownText} files={linkable} />
              ) : (
                writing && <div class="dim">Claude is reading the code…</div>
              )}
              {explain?.error && <div class="error">{explain.error}</div>}
              <div class="actions">
                {card.pending ? (
                  writing ? (
                    <button onClick={() => post({ type: 'cancel', cardId: card.id })}>
                      Cancel
                    </button>
                  ) : (
                    <button class="primary" onClick={() => post({ type: 'retry', id: card.id })}>
                      Retry
                    </button>
                  )
                ) : (
                  <>
                    {canPost && !posted && card.state !== 'stale' && (
                      <button
                        class="primary"
                        disabled={writing}
                        title="Post this comment on the pull request now, on its own"
                        onClick={() => post({ type: 'postComment', id: card.id })}
                      >
                        Post to PR
                      </button>
                    )}
                    {!posted && (
                      <button disabled={writing} onClick={() => setEditing(card.body)}>
                        Edit
                      </button>
                    )}
                    {writing && (
                      <button onClick={() => post({ type: 'cancel', cardId: card.id })}>
                        Cancel
                      </button>
                    )}
                    {card.file && <button onClick={onSelect}>Go to Code</button>}
                  </>
                )}
                <button class="quiet" onClick={() => post({ type: 'remove', id: card.id })}>
                  Remove
                </button>
              </div>
              {posted && card.thread.length > 0 && <Thread entries={card.thread} />}
              {posted && card.githubThread && (
                <GithubReply card={card} run={props.replyRun} asking={false} />
              )}
              {!card.pending && !posted && (
                <Ask
                  draft={draft}
                  onDraft={onDraft}
                  onSend={onAsk}
                  running={writing}
                  onCancel={() => post({ type: 'cancel', cardId: card.id })}
                  placeholder="Ask Claude to rewrite it: shorter, friendlier, in English…"
                />
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A note's GitHub conversation, from here: Claude sums it up (into the conversation) or drafts
 * a reply; the reply, drafted or written by hand, is edited here and posted on GitHub.
 */
function GithubReply(props: { card: CardView; run?: Answer; asking: boolean }) {
  const { card, run } = props;
  const drafting = !!run && !run.done;
  const [text, setText] = useState<string | null>(null);
  const [lastDraft, setLastDraft] = useState(card.reply);
  // A new draft from Claude replaces what is in the box.
  if (card.reply !== lastDraft) {
    setLastDraft(card.reply);
    if (card.reply !== undefined) setText(card.reply);
  }
  const shown = drafting ? run.text : (text ?? card.reply);
  const open = drafting || shown !== undefined;
  return (
    <div class="gh-reply">
      <div class="actions">
        <span class="dim">GitHub</span>
        <button
          disabled={props.asking}
          title="Have Claude sum up this discussion: who said what, what is agreed, what is open"
          onClick={() => post({ type: 'summarizeThread', id: card.id })}
        >
          Summarize Thread
        </button>
        <button
          disabled={drafting}
          title="Have Claude draft a reply to the latest message, to edit and post"
          onClick={() => post({ type: 'draftReply', id: card.id })}
        >
          Draft Reply
        </button>
        {!open && <button onClick={() => setText('')}>Reply</button>}
      </div>
      {run?.error && <div class="error">{run.error}</div>}
      {open && (
        <>
          <textarea
            class="comment-edit"
            rows={Math.min(14, (shown ?? '').split('\n').length + 2)}
            value={shown ?? ''}
            readOnly={drafting}
            placeholder="Your reply on GitHub…"
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
          <div class="actions">
            {drafting ? (
              <button onClick={() => post({ type: 'cancel', cardId: `reply:${card.id}` })}>
                Cancel
              </button>
            ) : (
              <>
                <button
                  class="primary"
                  disabled={!(shown ?? '').trim()}
                  onClick={() => post({ type: 'postReply', id: card.id, body: shown ?? '' })}
                >
                  Post Reply
                </button>
                <button
                  onClick={() => {
                    setText(null);
                    if (card.reply !== undefined) post({ type: 'discardReply', id: card.id });
                  }}
                >
                  Discard
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Its GitHub thread is resolved, and by whom. */
function resolvedText(card: CardView): string {
  return `resolved on GitHub${card.resolvedBy ? ` by ${card.resolvedBy}` : ''}`;
}

/** The mark on a note whose GitHub thread is resolved. */
function Resolved({ card }: { card: CardView }) {
  return (
    <span class="resolved-mark" title={`This thread is ${resolvedText(card)}`}>
      ✓ Resolved
    </span>
  );
}
