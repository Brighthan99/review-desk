import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReviewController } from '../controller';
import { isFileNote, type Annotation, type ResolvedAnnotation } from '../review/model';
import { readSide } from '../review/target';
import type { SelectionRef, ToPanel } from '../shared/protocol';
import { buildQuestionPrompt, type CodeExcerpt } from './prompt';
import type { AgentRunner, RunHandle } from './runner';
import { translatableParts } from './translate';
import { ofAgent, worthContinuing } from './session';

export interface QuestionSettings {
  maxConcurrent: number;
  maxBudgetUsd: number;
  /** Cost limit of a summary, which reads every diff. */
  summaryMaxBudgetUsd: number;
  tools: string;
  /** The agent that runs now (reviewDesk.agent): sessions are continued by their own agent only. */
  agent?: 'claude' | 'codex';
  model?: string;
  /** How hard the model thinks (reviewDesk.effort); empty: Claude Code's default. */
  effort?: string;
  /** Language the agent writes notes and answers in. */
  language: string;
  /** Language PR comments are drafted in (the notes' language when not set). */
  commentLanguage?: string;
  /** What a summary of the whole change adds: a flow diagram, the order to read it in. */
  summaryDiagram?: boolean;
  summaryReadingOrder?: boolean;
}

export interface AnswerState {
  text: string;
  done: boolean;
  error?: string;
}

const MAX_EXCERPT_LINES = 80;

/**
 * Sends panel questions to the agent. A card's first question forks the session that wrote
 * the explanations (so the agent already knows the code); later questions on the same card
 * resume that fork, keeping each card's conversation separate. A session left idle (or grown
 * big) is not continued: the question starts a new session whose prompt carries the diff,
 * the note and its conversation so far (see session.ts).
 */
export class QuestionService {
  private readonly running = new Map<string, RunHandle>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  /** Latest answer per card while it streams, so a reopened panel can catch up. */
  readonly answers = new Map<string, AnswerState>();

  constructor(
    private readonly controller: ReviewController,
    private readonly runner: AgentRunner,
    private readonly settings: () => QuestionSettings,
    private readonly post: (msg: ToPanel) => void,
  ) {}

  isRunning(cardId: string): boolean {
    return this.running.has(cardId) || this.answers.get(cardId)?.done === false;
  }

  /** Asks about a card, or about the whole change / a selection when `cardId` is null. Returns the card id. */
  async ask(
    cardId: string | null,
    question: string,
    selection?: SelectionRef,
    file?: string,
  ): Promise<string | undefined> {
    const { target } = this.controller;
    if (!target || !question.trim()) return undefined;
    const id = cardId ?? this.createQuestionCard(question, selection, file);
    if (!id || this.isRunning(id)) return id;

    const before = this.controller.annotation(id);
    if (!before) return undefined;
    const history = before.thread ?? [];
    this.controller.mutate((review) => {
      const a = review.annotations.find((x) => x.id === id);
      if (!a) return;
      a.thread = [
        ...(a.thread ?? []),
        { from: 'user', body: question, at: new Date().toISOString(), selection },
      ];
    });

    // A card created just now is not resolved yet; its stored form says what it is about.
    const card =
      this.controller.resolved.find((a) => a.id === id) ??
      ({
        ...before,
        number: 0,
        state: 'ok',
        resolvedStart: before.startLine,
        resolvedEnd: before.endLine,
      } satisfies ResolvedAnnotation);
    const review = this.controller.review!;
    const language = this.settings().language;
    const continuing = before.threadSession
      ? {
          id: before.threadSession,
          use: { usedAt: history.at(-1)?.at, tokens: before.threadTokens },
        }
      : review.session && { id: review.session.id, use: review.session };
    const resume =
      continuing && worthContinuing(continuing.use) && ofAgent(continuing.id, this.settings().agent)
        ? continuing.id
        : undefined;
    const prompt = buildQuestionPrompt({
      target,
      review,
      card,
      cardCode: card ? await this.cardCode(card) : undefined,
      selection: selection ? this.selectionCode(selection) : undefined,
      history,
      question,
      continuesSession: resume !== undefined,
      language,
    });

    this.update(id, { text: '', done: false });
    await this.slot();
    // Cancelled while it waited for its turn (Cancel, the card removed, the panel gone): it
    // does not run, nor cost anything.
    if (this.cancelled.delete(id) || this.disposed || !this.controller.annotation(id)) {
      this.release();
      this.update(id, { text: '', done: true, error: 'Cancelled.' });
      return id;
    }
    const s = this.settings();
    const handle = this.runner.run(
      {
        prompt,
        cwd: target.root,
        resume,
        fork: resume !== undefined && resume !== before.threadSession,
        tools: s.tools,
        maxBudgetUsd: s.maxBudgetUsd,
        budgetSetting: 'reviewDesk.maxBudgetUsd',
        model: s.model,
        effort: s.effort,
      },
      (text) => this.update(id, { text, done: false }),
    );
    this.running.set(id, handle);
    const result = await handle.done;
    this.running.delete(id);
    this.release();

    if (result.error) {
      this.update(id, { text: result.text, done: true, error: result.error });
      return id;
    }
    // Into the review asked in, even when another is open by now.
    this.controller.mutateAt({ gitDir: target.gitDir, headSha: target.head.sha }, (r) => {
      const a = r.annotations.find((x) => x.id === id);
      if (!a) return;
      // In one language while all of Claude's text is: the first, or the same as before.
      const first = translatableParts(a).length === 0;
      a.language = first || a.language === language ? language : undefined;
      a.thread = [
        ...(a.thread ?? []),
        { from: 'ai', body: result.text, at: new Date().toISOString() },
      ];
      if (result.sessionId) {
        a.threadSession = result.sessionId;
        a.threadTokens = result.contextTokens;
      }
    });
    this.update(id, { text: result.text, done: true });
    this.answers.delete(id);
    return id;
  }

  /** Questions cancelled while waiting for their turn: not run when it comes. */
  private readonly cancelled = new Set<string>();
  private disposed = false;

  cancel(cardId: string): void {
    const running = this.running.get(cardId);
    if (running) running.cancel();
    else if (this.answers.get(cardId)?.done === false) this.cancelled.add(cardId);
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.running.values()) h.cancel();
  }

  private update(cardId: string, state: AnswerState): void {
    this.answers.set(cardId, state);
    this.post({ type: 'answer', cardId, ...state });
  }

  private async slot(): Promise<void> {
    if (this.active < this.settings().maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  /**
   * A `question` card holds a question about the whole change, a whole file (lines 0, like a
   * file summary) or a selection.
   */
  createQuestionCard(
    question: string,
    selection?: SelectionRef,
    file?: string,
  ): string | undefined {
    const id = `q${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const title = question.split('\n')[0].slice(0, 60) + (question.length > 60 ? '…' : '');
    const anchorText = selection
      ? (this.workTreeLines(selection.file)?.[selection.startLine - 1] ?? '')
      : '';
    let created = false;
    this.controller.mutate((review) => {
      const order = Math.max(0, ...review.annotations.map((a) => a.order ?? 0)) + 1;
      const card: Annotation = {
        id,
        file: selection?.file ?? file ?? '',
        side: 'new',
        startLine: selection?.startLine ?? 0,
        endLine: selection?.endLine ?? 0,
        anchorText,
        kind: 'question',
        title,
        body: '',
        group: 'Questions',
        order,
      };
      review.annotations.push(card);
      created = true;
    });
    return created ? id : undefined;
  }

  private workTreeLines(file: string): string[] | undefined {
    try {
      return fs.readFileSync(path.join(this.controller.target!.root, file), 'utf8').split('\n');
    } catch {
      return undefined;
    }
  }

  private selectionCode(s: SelectionRef): CodeExcerpt | undefined {
    const lines = this.workTreeLines(s.file);
    if (!lines) return undefined;
    const end = Math.min(s.endLine, s.startLine + MAX_EXCERPT_LINES - 1);
    return { file: s.file, startLine: s.startLine, lines: lines.slice(s.startLine - 1, end) };
  }

  private async cardCode(card: ResolvedAnnotation): Promise<CodeExcerpt | undefined> {
    if (!card.file || isFileNote(card)) return undefined;
    const lines = await readSide(this.controller.target!, card.side, card.file);
    if (!lines) return undefined;
    const end = Math.min(card.resolvedEnd, card.resolvedStart + MAX_EXCERPT_LINES - 1);
    return {
      file: card.file,
      startLine: card.resolvedStart,
      lines: lines.slice(card.resolvedStart - 1, end),
    };
  }
}
