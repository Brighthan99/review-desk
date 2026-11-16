import type { ReviewController } from '../controller';
import type { Annotation, Review } from '../review/model';
import { DIAGRAM_BLOCK, ORDER_BLOCK, splitSummary } from '../shared/summary';
import type { ToPanel } from '../shared/protocol';
import type { AgentRunner } from './runner';

export interface TranslateSettings {
  maxConcurrent: number;
  maxBudgetUsd: number;
  model?: string;
}

/** Where a piece of a note's text is: its title, its body, or an answer in its thread. */
type Slot = 'title' | 'body' | number;

/**
 * The parts of a note Claude wrote, to translate: its title and body (a question card's title
 * is the reviewer's question) and its answers. The reviewer's own questions, and notes from
 * elsewhere (a GitHub review), stay as they are.
 */
export function translatableParts(a: Annotation): { slot: Slot; text: string }[] {
  if (a.source || a.pending) return [];
  const parts: { slot: Slot; text: string }[] = [];
  if (a.kind !== 'question') parts.push({ slot: 'title', text: a.title });
  if (a.body.trim()) parts.push({ slot: 'body', text: a.body });
  (a.thread ?? []).forEach((m, i) => {
    if (m.from === 'ai' && !m.author && m.body.trim()) parts.push({ slot: i, text: m.body });
  });
  return parts;
}

/** Whether a note has text of Claude's that is not (known to be) in `language`. */
export function needsTranslation(a: Annotation, language: string): boolean {
  // A PR comment is in the language it is posted in (reviewDesk.commentLanguage).
  if (a.kind === 'comment') return false;
  return translatableParts(a).length > 0 && a.language?.toLowerCase() !== language.toLowerCase();
}

export function buildTranslatePrompt(texts: string[], language: string): string {
  return [
    '[Review Desk: translate]',
    `Translate the texts below into ${language}. They are notes and answers written during a code review.`,
    '',
    `- Reply with only a JSON array of ${texts.length} strings: the translations, in the same order.`,
    '- Keep markdown formatting, code (inline and in blocks), identifiers, file paths, `path:line` references and URLs exactly as they are.',
    `- A text already in ${language} stays as it is.`,
    '',
    'The texts, as a JSON array:',
    JSON.stringify(texts),
  ].join('\n');
}

/** The translations in Claude's reply, or undefined when it is not `count` strings. */
export function parseTranslation(reply: string, count: number): string[] | undefined {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start < 0 || end < start) return undefined;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) &&
      parsed.length === count &&
      parsed.every((t) => typeof t === 'string')
      ? (parsed as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

/** The id the summary's translation goes by (in `translate` and the panel's messages). */
export const SUMMARY = '#summary';

/** Whether the review has a summary not (known to be) in `language`. */
export function summaryNeedsTranslation(review: Review, language: string): boolean {
  return (
    !!review.overview &&
    !!summaryPieces(review.overview) &&
    review.overviewLanguage?.toLowerCase() !== language.toLowerCase()
  );
}

/**
 * A summary's text to translate: its text, then each step of its reading order (title and
 * why); and how to put it together again with the translations, its diagram and the files
 * of each step as they were. None for one whose reading order is broken (it would be lost).
 */
export function summaryPieces(
  overview: string,
): { texts: string[]; rebuild: (translated: string[]) => string } | undefined {
  const parts = splitSummary(overview);
  if (parts.orderError || parts.writing) return undefined;
  const order = parts.order ?? [];
  const texts = [parts.text, ...order.flatMap((step) => [step.title, step.why ?? ''])];
  const rebuild = (t: string[]) => {
    const steps = order.map((step, i) => ({
      title: t[1 + 2 * i].trim() || step.title,
      ...(t[2 + 2 * i].trim() ? { why: t[2 + 2 * i].trim() } : {}),
      files: step.files.map(
        (f) => `${f.file}${f.start ? `:${f.start}${f.end !== f.start ? `-${f.end}` : ''}` : ''}`,
      ),
    }));
    return [
      t[0].trim(),
      parts.diagram && `\`\`\`${DIAGRAM_BLOCK}\n${parts.diagram}\n\`\`\``,
      steps.length && `\`\`\`${ORDER_BLOCK}\n${JSON.stringify(steps, null, 2)}\n\`\`\``,
    ]
      .filter(Boolean)
      .join('\n\n');
  };
  return { texts, rebuild };
}

/**
 * Translates notes into another language, each in a claude run of its own (no tools, no
 * session: the text is all it needs), a few at a time. The panel hears of each note being
 * translated, done or failed; the note itself changes in the review file.
 */
export class NoteTranslator {
  /** Notes being translated, and the ones that failed (with why), for the panel. */
  readonly states = new Map<string, { running: boolean; error?: string }>();

  constructor(
    private readonly controller: ReviewController,
    private readonly runner: AgentRunner,
    private readonly settings: () => TranslateSettings,
    private readonly post: (msg: ToPanel) => void,
  ) {}

  /** The summary and the notes of the review not (known to be) in `language`. */
  candidates(language: string): string[] {
    const review = this.controller.review;
    const summary =
      review && summaryNeedsTranslation(review, language) && !this.states.get(SUMMARY)?.running
        ? [SUMMARY]
        : [];
    const notes = (review?.annotations ?? [])
      .filter((a) => needsTranslation(a, language) && !this.states.get(a.id)?.running)
      .map((a) => a.id);
    return [...summary, ...notes];
  }

  /**
   * Translates the notes `ids` (`SUMMARY` for the summary) into `language`; returns how many
   * were and how many failed.
   */
  async translate(ids: string[], language: string): Promise<{ done: number; failed: number }> {
    const queue = [...ids];
    let done = 0;
    let failed = 0;
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const ok =
          id === SUMMARY
            ? await this.translateSummary(language)
            : await this.translateNote(id, language);
        if (ok) done++;
        else failed++;
      }
    };
    const workers = Math.max(1, Math.min(this.settings().maxConcurrent, queue.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return { done, failed };
  }

  private async translateNote(id: string, language: string): Promise<boolean> {
    const note = this.controller.annotation(id);
    const parts = note ? translatableParts(note) : [];
    if (!parts.length) return false;
    const translated = await this.run(
      id,
      parts.map((p) => p.text),
      language,
    );
    if (!translated) return false;
    this.controller.mutate((r) => {
      const a = r.annotations.find((x) => x.id === id);
      if (!a) return;
      // Only what is still as it was: an answer that arrived meanwhile keeps its text.
      let all = true;
      parts.forEach((p, i) => {
        const now =
          p.slot === 'title' ? a.title : p.slot === 'body' ? a.body : a.thread?.[p.slot]?.body;
        if (now !== p.text) {
          all = false;
          return;
        }
        if (p.slot === 'title') a.title = translated[i].trim() || a.title;
        else if (p.slot === 'body') a.body = translated[i];
        else a.thread![p.slot].body = translated[i];
      });
      const extra = translatableParts(a).length > parts.length;
      a.language = all && !extra ? language : undefined;
    });
    this.done(id);
    return true;
  }

  /** The summary: its text and reading order translated, its diagram and files as they are. */
  private async translateSummary(language: string): Promise<boolean> {
    const overview = this.controller.review?.overview;
    const pieces = overview ? summaryPieces(overview) : undefined;
    if (!overview || !pieces) return false;
    const translated = await this.run(SUMMARY, pieces.texts, language);
    if (!translated) return false;
    this.controller.mutate((r) => {
      // Written again meanwhile: that one stays.
      if (r.overview !== overview) return;
      r.overview = pieces.rebuild(translated);
      r.overviewLanguage = language;
    });
    this.done(SUMMARY);
    return true;
  }

  /** One claude run translating `texts`: the translations, or undefined (the panel told why). */
  private async run(id: string, texts: string[], language: string): Promise<string[] | undefined> {
    const target = this.controller.target;
    if (!target || this.states.get(id)?.running) return undefined;
    this.update(id, { running: true });
    const s = this.settings();
    const handle = this.runner.run(
      {
        prompt: buildTranslatePrompt(texts, language),
        cwd: target.root,
        tools: '',
        maxBudgetUsd: s.maxBudgetUsd,
        budgetSetting: 'reviewDesk.maxBudgetUsd',
        model: s.model,
        // Putting text into another language needs no deliberation.
        effort: 'low',
      },
      () => undefined,
    );
    const result = await handle.done;
    const translated = result.error ? undefined : parseTranslation(result.text, texts.length);
    if (!translated) {
      this.update(id, {
        running: false,
        error: result.error ?? 'The translation came back in an unexpected form. Try again.',
      });
    }
    return translated;
  }

  private done(id: string): void {
    this.states.delete(id);
    this.post({ type: 'translation', cardId: id, running: false });
  }

  private update(id: string, state: { running: boolean; error?: string }): void {
    this.states.set(id, state);
    this.post({ type: 'translation', cardId: id, ...state });
  }
}
