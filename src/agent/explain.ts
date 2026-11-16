import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReviewController } from '../controller';
import { formatForAgent, type DiffFile, type Side } from '../review/diffParser';
import { isFileNote, type Annotation } from '../review/model';
import { diffDigest, fileDigest, findFile, readSide } from '../review/target';
import { parseComment } from '../shared/comment';
import { parseExplanation } from '../shared/explanation';
import type { ToPanel } from '../shared/protocol';
import {
  buildCommentPrompt,
  buildReplyPrompt,
  buildExplainPrompt,
  buildFileSummaryPrompt,
  buildSummaryPrompt,
} from './prompt';
import type { AnswerState, QuestionSettings } from './questions';
import type { AgentRunner, RunHandle } from './runner';
import { ofAgent, worthContinuing } from './session';

export interface ExplainRequest {
  /** Repository-relative path; for the old side of a renamed file, the new path. */
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
  /** Text of `startLine` as the reviewer sees it. */
  anchorText: string;
}

const MAX_CODE_LINES = 200;

/** How a session remembers a file's diff: a file edited since is sent again. */
const diffKey = (file: string, changed: DiffFile | undefined) =>
  `${file}\0${changed ? formatForAgent([changed]) : ''}`;

/**
 * Writes explanations for the lines the reviewer picks. Each request becomes a card at once
 * and the agent's answer streams into it. Requests share one session per review, resumed in
 * turn, so later explanations build on what the agent already read; questions on a card fork
 * that session like before. A session left idle (or grown big) is not resumed: a new one
 * starts, which costs less than sending its whole history again (see session.ts). A summary of the whole change runs on its own, in a new session:
 * resuming the explaining session would send its whole history again with every diff.
 */
export class ExplainService {
  private queue: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, RunHandle>();
  private readonly cancelled = new Set<string>();
  /** Diffs each session has been sent, as `file\0diff` (a file edited since is sent again). */
  private readonly seen = new Map<string, Set<string>>();
  /** Latest text per card while it is queued or streams, so a reopened panel can catch up. */
  readonly states = new Map<string, AnswerState>();
  /** The summary while it is queued or streams, or how it failed. */
  summary: AnswerState | undefined;
  private summaryRun: RunHandle | undefined;
  /** Bumped by each request and cancel: only the latest request may write. */
  private summaryGeneration = 0;
  /** PR comments being rewritten: the comment before, and how the reviewer wants it changed. */
  private readonly revisions = new Map<string, { comment: string; how: string }>();

  constructor(
    private readonly controller: ReviewController,
    private readonly runner: AgentRunner,
    private readonly settings: () => QuestionSettings,
    private readonly post: (msg: ToPanel) => void,
  ) {}

  isRunning(cardId: string): boolean {
    return this.states.get(cardId)?.done === false;
  }

  /** Adds a card for the range and queues its explanation. Returns the card id. */
  request(req: ExplainRequest): string | undefined {
    const same = this.controller.resolved.find(
      (a) =>
        a.kind !== 'question' &&
        a.kind !== 'comment' &&
        !a.source &&
        a.file === req.file &&
        a.side === req.side &&
        a.resolvedStart === req.startLine &&
        a.resolvedEnd === req.endLine,
    );
    if (same) {
      if (same.pending && !this.isRunning(same.id)) this.enqueue(same.id);
      return same.id;
    }

    const id = `e${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const created = this.controller.mutate((review) => {
      const order = Math.max(0, ...review.annotations.map((a) => a.order ?? 0)) + 1;
      const card: Annotation = {
        id,
        file: req.file,
        side: req.side,
        startLine: req.startLine,
        endLine: req.endLine,
        anchorText: req.anchorText,
        kind: 'how',
        title: 'Writing…',
        body: '',
        group: req.file,
        order,
        pending: true,
      };
      review.annotations.push(card);
    });
    if (!created) return undefined;
    this.enqueue(id);
    return id;
  }

  /**
   * Adds a summary card for a whole file, changed or not, and queues it. The file's card is
   * reused; one written for an older version of the file is written again. Returns its id.
   */
  summarizeFile(file: string): string | undefined {
    const same = this.controller.resolved.find(
      (a) => isFileNote(a) && a.file === file && !a.source && a.kind !== 'question',
    );
    if (same) {
      if (this.isRunning(same.id)) return same.id;
      if (same.state === 'stale' && !same.pending) {
        this.controller.mutate((r) => {
          const a = r.annotations.find((x) => x.id === same.id);
          if (!a) return;
          a.pending = true;
          delete a.understood;
        });
      }
      if (same.pending || same.state === 'stale') this.enqueue(same.id);
      return same.id;
    }

    const id = `f${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const created = this.controller.mutate((review) => {
      const order = Math.max(0, ...review.annotations.map((a) => a.order ?? 0)) + 1;
      review.annotations.push({
        id,
        file,
        side: 'new',
        startLine: 0,
        endLine: 0,
        anchorText: '',
        kind: 'overview',
        title: 'Summarizing…',
        body: '',
        group: file,
        order,
        pending: true,
      });
    });
    if (!created) return undefined;
    this.enqueue(id);
    return id;
  }

  /**
   * Adds a PR comment card for the range and queues its draft: a review comment for the pull
   * request's author, saying what `request` asks (else what Claude finds worth saying).
   * Several comments may sit on the same lines. Returns the card id.
   */
  draftComment(req: ExplainRequest, request?: string): string | undefined {
    const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const created = this.controller.mutate((review) => {
      const order = Math.max(0, ...review.annotations.map((a) => a.order ?? 0)) + 1;
      review.annotations.push({
        id,
        file: req.file,
        side: req.side,
        startLine: req.startLine,
        endLine: req.endLine,
        anchorText: req.anchorText,
        kind: 'comment',
        title: 'Writing…',
        body: '',
        group: req.file,
        order,
        pending: true,
        ...(request?.trim() && { request: request.trim() }),
      });
    });
    if (!created) return undefined;
    this.enqueue(id);
    return id;
  }

  /**
   * Rewrites a PR comment as the reviewer asks (shorter, friendlier, another language…). The
   * comment as it reads stays until the new one is written; a failed rewrite leaves it as it was.
   */
  reviseComment(cardId: string, how: string): boolean {
    const card = this.controller.annotation(cardId);
    if (card?.kind !== 'comment' || card.pending || this.isRunning(cardId)) return false;
    this.revisions.set(cardId, { comment: card.body, how });
    this.enqueue(cardId);
    return true;
  }

  /**
   * Drafts a reply in a note's GitHub thread (an imported thread, or replies to a note posted
   * from here): written as it streams under `reply:<id>`, then kept as the note's `reply` to
   * edit and post. Returns false when it cannot (no thread, one being written).
   */
  draftReply(cardId: string): boolean {
    const key = `reply:${cardId}`;
    const card = this.controller.annotation(cardId);
    if (!card?.thread?.some((m) => m.githubId !== undefined) || this.isRunning(key)) return false;
    this.update(key, { text: '', done: false });
    this.queue = this.queue.then(() =>
      this.runReply(cardId).catch((e: unknown) =>
        this.update(key, { text: '', done: true, error: String(e) }),
      ),
    );
    return true;
  }

  private async runReply(cardId: string): Promise<void> {
    const key = `reply:${cardId}`;
    const { target } = this.controller;
    const card = this.controller.annotation(cardId);
    if (!target || !card) return;
    const me = this.controller.review?.github?.login;
    const posted = card.postedAs ? [{ author: me ?? 'the reviewer', body: card.body }] : [];
    const thread = [
      ...posted,
      ...(card.thread ?? [])
        .filter((m) => m.githubId !== undefined)
        .map((m) => ({ author: m.author ?? 'someone', body: m.body })),
    ];
    const code =
      card.file && card.startLine
        ? (await this.lines(card)).slice(card.startLine - 1, card.endLine).slice(0, MAX_CODE_LINES)
        : undefined;
    const s = this.settings();
    const handle = this.runner.run(
      {
        prompt: buildReplyPrompt({
          target,
          code: code && { file: card.file, startLine: card.startLine, lines: code },
          thread,
          me,
          language: s.commentLanguage || s.language,
        }),
        cwd: target.root,
        tools: s.tools,
        maxBudgetUsd: s.maxBudgetUsd,
        budgetSetting: 'reviewDesk.maxBudgetUsd',
        model: s.model,
        effort: s.effort,
      },
      (text) => this.update(key, { text, done: false }),
    );
    this.running.set(key, handle);
    const result = await handle.done;
    this.running.delete(key);
    if (result.error) {
      this.update(key, { text: result.text, done: true, error: result.error });
      return;
    }
    const reply = parseComment(result.text).body;
    this.controller.mutate((r) => {
      const a = r.annotations.find((x) => x.id === cardId);
      if (a) a.reply = reply;
    });
    this.states.delete(key);
    this.post({ type: 'explain', cardId: key, text: result.text, done: true });
  }

  /** Asks again for a card whose explanation failed or was interrupted. */
  retry(cardId: string): void {
    if (this.controller.annotation(cardId)?.pending && !this.isRunning(cardId)) {
      this.enqueue(cardId);
    }
  }

  cancel(cardId: string): void {
    this.cancelled.add(cardId);
    this.running.get(cardId)?.cancel();
  }

  get isSummarizing(): boolean {
    return this.summary?.done === false;
  }

  /** Queues a summary of the whole change, which becomes the review's overview. */
  summarize(): boolean {
    if (!this.controller.target?.files.length || this.isSummarizing) return false;
    const generation = ++this.summaryGeneration;
    this.updateSummary({ text: '', done: false });
    this.runSummary(generation).catch((e: unknown) => {
      if (generation === this.summaryGeneration)
        this.updateSummary({ text: '', done: true, error: String(e) });
    });
    return true;
  }

  /** Stops the summary; the previous one, if any, stays. */
  cancelSummary(): void {
    if (!this.isSummarizing) return;
    this.summaryGeneration++;
    this.summaryRun?.cancel();
    this.updateSummary(undefined);
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.running.values()) h.cancel();
    this.summaryRun?.cancel();
  }

  /** Gone with the extension: explanations still queued do not start. */
  private disposed = false;

  private enqueue(cardId: string): void {
    this.cancelled.delete(cardId);
    this.update(cardId, { text: '', done: false });
    this.queue = this.queue.then(() =>
      this.run(cardId).catch((e: unknown) =>
        this.update(cardId, { text: '', done: true, error: String(e) }),
      ),
    );
  }

  private update(cardId: string, state: AnswerState): void {
    this.states.set(cardId, state);
    this.post({ type: 'explain', cardId, ...state });
  }

  private updateSummary(state: AnswerState | undefined): void {
    this.summary = state;
    this.post({ type: 'summary', run: state ?? null });
  }

  private async runSummary(generation: number): Promise<void> {
    const current = () => generation === this.summaryGeneration;
    const { target } = this.controller;
    if (!current()) return;
    if (!target?.files.length) {
      this.updateSummary(undefined);
      return;
    }
    // The change as it is now: edits made while the agent writes make the summary outdated.
    const digest = diffDigest(target);
    const s = this.settings();
    const language = s.language;
    const handle = this.runner.run(
      {
        prompt: buildSummaryPrompt(target, language, {
          diagram: s.summaryDiagram,
          readingOrder: s.summaryReadingOrder,
        }),
        cwd: target.root,
        tools: s.tools,
        maxBudgetUsd: s.summaryMaxBudgetUsd,
        budgetSetting: 'reviewDesk.summaryMaxBudgetUsd',
        model: s.model,
        effort: s.effort,
      },
      (text) => current() && this.updateSummary({ text, done: false }),
    );
    this.summaryRun = handle;
    const result = await handle.done;
    // An earlier run, cancelled, may end after a new one started: that one's handle stays (to
    // cancel it).
    if (this.summaryRun === handle) this.summaryRun = undefined;
    if (!current()) return;
    if (result.error) {
      this.updateSummary({ text: result.text, done: true, error: result.error });
      return;
    }
    this.controller.mutate((r) => {
      // Another review may be open by now.
      if (r.head.sha !== target.head.sha || r.base.sha !== target.base.sha) return;
      r.overview = result.text.trim();
      r.overviewOf = digest;
      r.overviewLanguage = language;
    });
    // The panel gets the new overview before the streamed text goes away.
    await this.controller.reload();
    this.updateSummary(undefined);
  }

  private async run(cardId: string): Promise<void> {
    const { target } = this.controller;
    const card = this.controller.annotation(cardId);
    const review = this.controller.storedReview();
    if (!target || !card || !review) {
      this.states.delete(cardId);
      return;
    }
    if (this.cancelled.has(cardId) || this.disposed) {
      this.update(cardId, { text: '', done: true, error: 'Cancelled.' });
      return;
    }
    // Where the lines are now: they may have moved since it was asked (queued, or retried
    // later), as the note's anchor tells.
    const now = this.controller.resolved.find((a) => a.id === cardId);
    const at =
      now && now.state !== 'stale'
        ? { start: now.resolvedStart, end: now.resolvedEnd }
        : { start: card.startLine, end: card.endLine };

    const session =
      worthContinuing(review.session) && ofAgent(review.session?.id, this.settings().agent)
        ? review.session!.id
        : undefined;
    const seen = (session && this.seen.get(session)) || new Set<string>();
    const key = diffKey(card.file, findFile(target, card.file));
    const fileNote = isFileNote(card);
    const comment = card.kind === 'comment';
    const revision = comment ? this.revisions.get(cardId) : undefined;
    this.revisions.delete(cardId);
    const language = comment
      ? this.settings().commentLanguage || this.settings().language
      : this.settings().language;
    let prompt: string;
    /** For a file summary: the version of the file it describes. */
    let digest: string | undefined;
    if (fileNote) {
      const content = await readSide(target, 'new', card.file);
      digest = fileDigest(target, card.file, content);
      prompt = buildFileSummaryPrompt({
        target,
        file: card.file,
        content: content ?? undefined,
        firstInSession: !session,
        includeFileDiff: !seen.has(key),
        language,
      });
    } else if (comment) {
      const code = (await this.lines(card)).slice(at.start - 1, at.end);
      prompt = buildCommentPrompt({
        target,
        code: { file: card.file, startLine: at.start, lines: code.slice(0, MAX_CODE_LINES) },
        side: card.side,
        truncated: code.length > MAX_CODE_LINES,
        firstInSession: !session,
        includeFileDiff: !seen.has(key),
        language,
        request: card.request,
        revise: revision,
      });
    } else {
      const code = (await this.lines(card)).slice(at.start - 1, at.end);
      prompt = buildExplainPrompt({
        target,
        code: {
          file: card.file,
          startLine: at.start,
          lines: code.slice(0, MAX_CODE_LINES),
        },
        side: card.side,
        truncated: code.length > MAX_CODE_LINES,
        firstInSession: !session,
        includeFileDiff: !seen.has(key),
        language,
      });
    }

    // Cancelled (or removed) while its code was read: not run.
    if (this.cancelled.has(cardId) || !this.controller.annotation(cardId)) {
      this.update(cardId, { text: '', done: true, error: 'Cancelled.' });
      return;
    }
    const s = this.settings();
    const handle = this.runner.run(
      {
        prompt,
        cwd: target.root,
        resume: session,
        tools: s.tools,
        maxBudgetUsd: s.maxBudgetUsd,
        budgetSetting: 'reviewDesk.maxBudgetUsd',
        model: s.model,
        effort: s.effort,
      },
      (text) => this.update(cardId, { text, done: false }),
    );
    this.running.set(cardId, handle);
    const result = await handle.done;
    this.running.delete(cardId);

    if (result.error) {
      this.update(cardId, { text: result.text, done: true, error: result.error });
      return;
    }
    const parsed = comment ? parseComment(result.text) : parseExplanation(result.text);
    if (result.sessionId) this.seen.set(result.sessionId, new Set([...seen, key]));
    // Into the review it was asked in, even when another is open by now (its answer would be
    // lost: no such card there), and into a later head's that carried it over.
    this.controller.mutateAt({ gitDir: target.gitDir, headSha: target.head.sha }, (r) => {
      const a = r.annotations.find((x) => x.id === cardId);
      if (!a) return;
      if (!comment) a.kind = fileNote ? 'overview' : parseExplanation(result.text).kind;
      a.title = parsed.title;
      a.body = parsed.body;
      a.language = language;
      if (digest) a.anchorText = digest;
      delete a.pending;
      if (result.sessionId) {
        r.session = {
          agent: s.agent === 'codex' ? 'codex' : 'claude-code',
          id: result.sessionId,
          usedAt: new Date().toISOString(),
          tokens: result.contextTokens,
        };
      }
    });
    this.states.delete(cardId);
    this.post({ type: 'explain', cardId, text: result.text, done: true });
  }

  /** The card's file as the review sees it, else as it is in the working tree (not committed). */
  private async lines(card: Annotation): Promise<string[]> {
    const target = this.controller.target!;
    const committed = await readSide(target, card.side, card.file);
    if (committed) return committed;
    try {
      return fs.readFileSync(path.join(target.root, card.file), 'utf8').split('\n');
    } catch {
      return [];
    }
  }
}
