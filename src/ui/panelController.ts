import type { AgentUse } from '../agent/agentUse';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorText, log, showError } from './log';
import { ExplainService, type ExplainRequest } from '../agent/explain';
import { QuestionService, type QuestionSettings } from '../agent/questions';
import { needsTranslation, NoteTranslator, summaryNeedsTranslation } from '../agent/translate';
import type { AgentRunner } from '../agent/runner';
import type { ReviewController } from '../controller';
import { filePath, type Side } from '../review/diffParser';
import { isFileNote, KIND_LABELS, type ResolvedAnnotation } from '../review/model';
import { checkCitations, citedPaths } from '../review/citations';
import { diffDigest, findFile, readSide } from '../review/target';
import { latestGithubAt, newReplies } from '../github/replies';
import { parseComment } from '../shared/comment';
import { splitSummary } from '../shared/summary';
import type {
  CitationView,
  ActiveFileInfo,
  CardView,
  CommentTarget,
  FromPanel,
  GithubCheck,
  PanelState,
  SelectionRef,
} from '../shared/protocol';
import { annotationsForUri } from './decorations';
import { openFileAt } from './diffView';
import { findUses } from './follow';
import { parseGitUri } from './gitApi';
import { PanelHost } from './panel';
import { setting } from '../settings';

/**
 * Connects the explanation panel to the editors: scrolling picks the card, clicking a card
 * reveals its code, the editor selection becomes the question target, and opening an
 * unchanged file switches the panel to that file.
 */
export class PanelController implements vscode.Disposable {
  readonly host: PanelHost;
  readonly questions: QuestionService;
  readonly explain: ExplainService;
  readonly translator: NoteTranslator;
  activeId: string | undefined;
  selection: SelectionRef | null = null;
  /** Lines picked for a PR comment that the editor selection does not show (see composeComment). */
  composing: CommentTarget | null = null;
  /** GitHub read for the pull request's replies: when last, or now. */
  githubCheck: GithubCheck | null = null;
  activeFile: ActiveFileInfo | null = null;
  /** The repository file in the active editor, kept while a non-file editor is in front. */
  currentFile: string | null = null;
  private suppressFocusUntil = 0;
  /** The card the reviewer closed: scrolling over its code does not open it again. */
  private closedId: string | undefined;
  private followSeq = 0;
  private laidOut = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    extensionUri: vscode.Uri,
    private readonly controller: ReviewController,
    runner: AgentRunner,
    private readonly settings: () => QuestionSettings,
    /** The agent it runs, for the header (none in tests that build it alone). */
    private readonly agent?: Pick<AgentUse, 'info' | 'onDidChange'>,
  ) {
    this.host = new PanelHost(extensionUri, (msg) => {
      this.receive(msg).catch((e: unknown) => showError(`Review Desk: ${errorText(e)}`, e));
    });
    this.questions = new QuestionService(controller, runner, settings, (m) => this.host.post(m));
    this.explain = new ExplainService(controller, runner, settings, (m) => this.host.post(m));
    this.translator = new NoteTranslator(controller, runner, settings, (m) => this.host.post(m));
    this.disposables.push(
      this.host,
      this.host.onDidBecomeReady(() => this.resync()),
      controller.onDidChange(() => {
        this.postState();
        this.showChatArrivals();
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.focusFromEditor(e.textEditor)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.trackSelection(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((e) => e && void this.follow(e)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('reviewDesk.language') ||
          e.affectsConfiguration('reviewDesk.claudePath')
        )
          this.postState();
      }),
    );
    if (agent) this.disposables.push(agent.onDidChange(() => this.postState()));
  }

  open(preserveFocus = true): void {
    const first = !this.host.isOpen;
    this.host.show(preserveFocus);
    this.postState();
    if (first && !this.laidOut && vscode.window.tabGroups.all.length === 2) {
      this.laidOut = true;
      void vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: 0.6 }, { size: 0.4 }],
      });
    }
  }

  /** Opens the panel with the current editor selection as the question target. */
  askAboutSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) this.trackSelection(editor);
    this.open(false);
    this.host.post({ type: 'focusAsk' });
  }

  /**
   * Asks the agent to explain the selected lines (the cursor line when nothing is selected)
   * of any file in the repository, changed or not.
   */
  async explainSelection(): Promise<string | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(
        'Review Desk: select the code to explain in an editor.',
      );
      return undefined;
    }
    const [startLine, endLine] = selectedLines(editor.selection);
    return this.explainLines(editor.document.uri, startLine, endLine);
  }

  /**
   * Explains lines of a document: a working tree file, or the base revision in a diff. With
   * `side: 'old'`, the lines are deleted lines of the base (a change handle on a deletion).
   * Starts a review of the file's repository first when none covers it.
   */
  async explainLines(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    side?: Side,
  ): Promise<string | undefined> {
    return this.cardOnLines(uri, startLine, endLine, side, (req) => this.explain.request(req));
  }

  /**
   * Drafts a PR comment on lines of a document, as explainLines explains them: a review comment
   * for the pull request's author saying what `request` asks (else what Claude finds worth
   * saying), shown as a card to edit, rewrite and post.
   */
  async draftCommentLines(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    side: Side | undefined,
    request: string | undefined,
  ): Promise<string | undefined> {
    return this.cardOnLines(uri, startLine, endLine, side, (req) =>
      this.explain.draftComment(req, request),
    );
  }

  /** Makes a card on lines of a document (see explainLines), opened in the panel. */
  private async cardOnLines(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    side: Side | undefined,
    make: (req: ExplainRequest) => string | undefined,
  ): Promise<string | undefined> {
    if (!(await this.ensureReview(uri))) return undefined;
    const where = this.locate(uri);
    if (!where) return this.cannotExplain();
    const target = this.controller.target!;
    const onSide = side ?? where.side;
    const text =
      onSide === 'old'
        ? ((await readSide(target, 'old', where.file)) ?? [])
        : (await vscode.workspace.openTextDocument(uri)).getText().split(/\r?\n/);
    const id = make({
      file: where.file,
      side: onSide,
      startLine,
      endLine,
      anchorText: text[startLine - 1] ?? '',
    });
    if (!id) return undefined;
    await this.controller.reload();
    this.open();
    await this.select(id, false);
    return id;
  }

  /**
   * Shows the summary of the whole change, writing it first when there is none yet or (`write`,
   * the Summarize Changes command) the change has moved on since. `show` (the Summary of
   * Changes row, a click to look) shows one out of date as it is, marked so, with Update in
   * the panel to write it again: looking never runs Claude Code. Starts a review when none is
   * open.
   */
  async summarize(mode: 'write' | 'show' = 'write'): Promise<boolean> {
    if (!this.controller.target && !(await this.controller.start({ open: false }))) return false;
    const { target, review } = this.controller;
    if (!target?.files.length) {
      void vscode.window.showInformationMessage(
        `Review Desk: there are no changes against ${target?.base.ref ?? 'the base'} to summarize.`,
      );
      return false;
    }
    this.open();
    if (this.activeFile) {
      // The summary is part of the review view, not of an unchanged file's view.
      this.followSeq++;
      this.activeFile = null;
      this.host.post({ type: 'activeFile', info: null });
    }
    const current = !!review?.overview && review.overviewOf === diffDigest(target);
    if (!review?.overview || (!current && mode === 'write')) this.explain.summarize();
    this.host.post({ type: 'focusSummary' });
    return true;
  }

  /**
   * Asks for a summary of a whole file of the repository, changed or not, shown as a note on
   * the file. Starts a review of the file's repository first when none covers it.
   */
  async summarizeFile(uri: vscode.Uri): Promise<string | undefined> {
    if (uri.scheme !== 'file') return this.cannotExplain();
    if (!(await this.ensureReview(uri))) return undefined;
    const file = this.relativePath(uri);
    if (file === undefined) return this.cannotExplain();
    const id = this.explain.summarizeFile(file);
    if (!id) return undefined;
    await this.controller.reload();
    this.open();
    await this.select(id, false);
    return id;
  }

  /**
   * Opens a file picked in the Review list next to the panel, and shows its section in the
   * panel (with Summarize when it has no summary).
   */
  async openFile(file: string, line?: number): Promise<void> {
    const target = this.controller.target;
    if (!target) return;
    this.open();
    await this.inCodeColumn((show) => openFileAt(target, file, line, show));
    this.setCurrentFile(file, true);
  }

  private setCurrentFile(file: string, focus = false): void {
    if (file === this.currentFile && !focus) return;
    this.currentFile = file;
    this.host.post({ type: 'currentFile', file, focus });
  }

  /**
   * Opens the box below the notes for a PR comment on lines of a document, where the reviewer
   * says what it should say (or leaves it to Claude) and drafts it. Lines after the change are
   * selected in the editor; deleted lines (old side) cannot be, so they are kept as the target
   * until other lines are selected.
   */
  async composeComment(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    side?: Side,
  ): Promise<void> {
    if (!(await this.ensureReview(uri))) return;
    const where = this.locate(uri);
    if (!where) return void this.cannotExplain();
    const onSide = side ?? where.side;
    if (onSide === 'new' && uri.scheme === 'file') await selectLines(uri, startLine, endLine);
    this.composing = { file: where.file, side: onSide, startLine, endLine };
    this.open(false);
    this.host.post({ type: 'compose', target: this.composing, focus: true });
  }

  /** Drafts a PR comment on lines given by the panel (see composeComment). */
  async draftCommentAt(target: CommentTarget, request: string): Promise<string | undefined> {
    const review = this.controller.target;
    if (!review) return undefined;
    let text: string[] | null = null;
    if (target.side === 'old') text = await readSide(review, 'old', target.file);
    else {
      try {
        text = fs.readFileSync(path.join(review.root, target.file), 'utf8').split(/\r?\n/);
      } catch {
        text = await readSide(review, 'new', target.file);
      }
    }
    const id = this.explain.draftComment(
      { ...target, anchorText: text?.[target.startLine - 1] ?? '' },
      request,
    );
    if (!id) return undefined;
    this.composing = null;
    this.host.post({ type: 'compose', target: null });
    await this.controller.reload();
    await this.select(id, false);
    return id;
  }

  /** Selects lines of a document and opens the question box with them as the target. */
  async askAboutLines(uri: vscode.Uri, startLine: number, endLine: number): Promise<void> {
    if (!(await this.ensureReview(uri))) return;
    await selectLines(uri, startLine, endLine);
    this.askAboutSelection();
  }

  /**
   * Shows the base ↔ working tree diff of a file at a line. By default it takes the place of
   * the file's tab (Show File turns it back); with `reviewDesk.diffOpensIn: newTab` it opens in
   * a tab of its own next to the file.
   */
  async showDiff(uri: vscode.Uri, line: number): Promise<void> {
    const target = this.controller.target;
    const file = this.relativePath(uri);
    if (!target || file === undefined) return;
    const fileTab = activeTabShowing(uri);
    const dirty = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === uri.toString(),
    )?.isDirty;
    // Closing the tab of unsaved changes would ask to save: keep it, as in a new tab.
    const inPlace = setting('diffOpensIn') !== 'newTab' && !dirty;
    const group = fileTab?.group;
    await openFileAt(target, file, line, {
      viewColumn: group?.viewColumn ?? vscode.window.activeTextEditor?.viewColumn,
      preserveFocus: false,
      // A file shown as a preview is simply replaced by the diff, shown the same way.
      preview: inPlace && !!fileTab?.isPreview,
    });
    if (inPlace && group) {
      const left = group.tabs.find(
        (t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString(),
      );
      if (left) await vscode.window.tabGroups.close(left, true);
    }
  }

  /**
   * Turns the diff in front back into its working tree file, at the same line and in the same
   * place among the tabs. Given the file (a hover link, the title bar), its diff shown in any
   * group: the group in front may be another one (the notes panel's).
   */
  async showFile(uri?: vscode.Uri): Promise<void> {
    // Either side may be given (the title bar of a diff passes the side it was clicked on).
    const isDiff = (t: vscode.Tab | undefined) =>
      t?.input instanceof vscode.TabInputTextDiff &&
      (!uri ||
        t.input.modified.toString() === uri.toString() ||
        t.input.original.toString() === uri.toString());
    const front = vscode.window.tabGroups.activeTabGroup.activeTab;
    const tab = isDiff(front)
      ? front
      : uri
        ? vscode.window.tabGroups.all.map((g) => g.activeTab).find(isDiff)
        : undefined;
    const input = tab?.input;
    if (!tab || !(input instanceof vscode.TabInputTextDiff)) return;
    const file = input.modified;
    // The right side's cursor, else the top of what it shows (focus may be on the left side).
    const right = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === file.toString(),
    );
    const line =
      right && vscode.window.activeTextEditor === right
        ? right.selection.active.line
        : (right?.visibleRanges[0]?.start.line ?? 0);
    const group = tab.group;
    // Open the file first (next to the diff, or replacing a diff preview), then close the diff.
    await vscode.window.showTextDocument(file, {
      viewColumn: group.viewColumn,
      preview: tab.isPreview,
      selection: new vscode.Range(line, 0, line, 0),
    });
    const diff = group.tabs.find(
      (t) =>
        t.input instanceof vscode.TabInputTextDiff &&
        t.input.modified.toString() === file.toString() &&
        t.input.original.toString() === input.original.toString(),
    );
    if (diff) await vscode.window.tabGroups.close(diff, true);
  }

  /** Switches the editor in front between a changed file and its diff. */
  async toggleDiff(): Promise<void> {
    if (
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff
    ) {
      return this.showFile();
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) await this.showDiff(editor.document.uri, editor.selection.active.line + 1);
  }

  /** Makes sure the open review covers the document, starting one for its repository if not. */
  private async ensureReview(uri: vscode.Uri): Promise<boolean> {
    const target = this.controller.target;
    if (target && (uri.scheme !== 'file' || this.relativePath(uri) !== undefined)) return true;
    if (uri.scheme !== 'file') {
      this.cannotExplain();
      return false;
    }
    return this.controller.start({ cwd: path.dirname(uri.fsPath), open: false, orHead: true });
  }

  private cannotExplain(): undefined {
    void vscode.window.showInformationMessage(
      'Review Desk: code in this editor cannot be explained. Select code in a file of the repository.',
    );
    return undefined;
  }

  /** The review file and side shown by an editor: working tree files are new, base revisions old. */
  private locate(uri: vscode.Uri): { file: string; side: Side } | undefined {
    const target = this.controller.target;
    if (!target) return undefined;
    if (uri.scheme === 'file') {
      const file = this.relativePath(uri);
      return file === undefined ? undefined : { file, side: 'new' };
    }
    const g = parseGitUri(uri);
    if (!g || g.ref !== target.base.sha) return undefined;
    const oldPath = path.relative(target.root, g.path).split(path.sep).join('/');
    const f = target.files.find((x) => x.oldPath === oldPath);
    return { file: f ? filePath(f) : oldPath, side: 'old' };
  }

  /** Deletes a card, stopping its explanation or answer if one is running. */
  remove(id: string): void {
    this.explain.cancel(id);
    this.questions.cancel(id);
    this.controller.mutate((r) => {
      r.annotations = r.annotations.filter((a) => a.id !== id);
    });
    if (this.activeId === id) this.activeId = undefined;
  }

  move(step: 1 | -1): void {
    const cards = this.controller.resolved;
    if (!cards.length) return;
    const i = cards.findIndex((a) => a.id === this.activeId);
    const next = cards[i < 0 ? 0 : Math.min(Math.max(i + step, 0), cards.length - 1)];
    void this.select(next.id, true);
  }

  /** What the Claude Code chat had written on each card at the last change (see chatMarks). */
  private chatSeen: { head: string; marks: Map<string, number> } | undefined;

  /**
   * Opens the panel on a card the Claude Code chat just saved or answered on (through the MCP
   * server, which writes the review file), so the reviewer sees it arrive.
   */
  private showChatArrivals(): void {
    const head = this.controller.target?.head.sha;
    const marks = new Map(this.controller.resolved.map((a) => [a.id, chatMarks(a)]));
    const before = head && this.chatSeen?.head === head ? this.chatSeen.marks : undefined;
    this.chatSeen = head ? { head, marks } : undefined;
    if (!before) return;
    const arrived = this.controller.resolved.find(
      (a) => (marks.get(a.id) ?? 0) > (before.get(a.id) ?? 0),
    );
    if (!arrived) return;
    this.open();
    void this.select(arrived.id, false);
  }

  async select(id: string, reveal: boolean): Promise<void> {
    this.activeId = id;
    this.closedId = undefined;
    this.controller.decorator.setActive(id);
    this.host.post({ type: 'focus', id });
    const card = this.controller.resolved.find((a) => a.id === id);
    // Opened: its new GitHub replies are seen now.
    const latest = card && latestGithubAt(card);
    if (latest && newReplies(card, this.controller.review?.github?.login).length) {
      this.controller.mutate((r) => {
        const a = r.annotations.find((x) => x.id === id);
        if (a && (!a.seenAt || latest > a.seenAt)) a.seenAt = latest;
      });
    }
    if (reveal && card) await this.reveal(card);
  }

  /** GitHub being read, or read (when), for the panel's Sync button; kept for a reopened panel. */
  setGithubCheck(c: GithubCheck): void {
    // While reading, the last time stays shown.
    this.githubCheck = { ...this.githubCheck, ...c, ...(c.running ? {} : { error: c.error }) };
    this.host.post({ type: 'githubCheck', check: this.githubCheck });
  }

  /** Opens the first note with new GitHub replies, at its code. */
  async showNewReplies(): Promise<void> {
    const me = this.controller.review?.github?.login;
    const card = this.controller.resolved.find((a) => newReplies(a, me).length);
    this.open(false);
    if (card) await this.select(card.id, true);
  }

  /** Closes the open card, and keeps it closed while the editor scrolls over its code. */
  close(id: string): void {
    if (this.activeId !== id) return;
    this.activeId = undefined;
    this.closedId = id;
    this.controller.decorator.setActive(undefined);
    this.host.post({ type: 'focus', id: null });
  }

  /** Handles a message from the panel. */
  async receive(msg: FromPanel): Promise<void> {
    const target = this.controller.target;
    switch (msg.type) {
      case 'select':
        await this.select(msg.id, true);
        break;
      case 'close':
        this.close(msg.id);
        break;
      case 'understood':
        this.controller.mutate((r) => {
          const a = r.annotations.find((x) => x.id === msg.id);
          if (a) a.understood = msg.value;
        });
        break;
      case 'ask': {
        // Said to a PR comment: how to rewrite it.
        if (msg.cardId && this.controller.annotation(msg.cardId)?.kind === 'comment') {
          this.explain.reviseComment(msg.cardId, msg.text);
          break;
        }
        const selection = msg.useSelection ? (this.selection ?? undefined) : undefined;
        // A new question: its card first, opened at once, so the answer shows as it comes
        // (Claude may read code for a while before it writes anything).
        const id =
          msg.cardId ??
          this.questions.createQuestionCard(msg.text, selection, selection ? undefined : msg.file);
        if (!id) break;
        if (msg.cardId === null) await this.select(id, false);
        await this.questions.ask(id, msg.text, selection);
        break;
      }
      case 'cancel':
        this.questions.cancel(msg.cardId);
        this.explain.cancel(msg.cardId);
        break;
      case 'retry':
        this.explain.retry(msg.id);
        break;
      case 'summarize':
        this.explain.summarize();
        break;
      case 'summarizeFile': {
        const id = target && this.explain.summarizeFile(msg.file);
        if (id) {
          await this.controller.reload();
          await this.select(id, false);
        }
        break;
      }
      case 'cancelSummary':
        this.explain.cancelSummary();
        break;
      case 'remove':
        this.remove(msg.id);
        break;
      case 'reveal':
        if (target) await this.showCode(msg.file, msg.line);
        break;
      case 'start':
        await vscode.commands.executeCommand('reviewDesk.start');
        break;
      case 'changeLanguage':
        await vscode.commands.executeCommand('reviewDesk.changeLanguage');
        break;
      case 'showReadingOrder':
        await vscode.commands.executeCommand('reviewDesk.tree.showReading');
        break;
      case 'translate':
        await this.translator.translate([msg.id], this.settings().language);
        break;
      case 'syncGithub':
        await vscode.commands.executeCommand('reviewDesk.github.sync');
        break;
      case 'chooseAgent':
        await vscode.commands.executeCommand('reviewDesk.chooseAgent');
        break;
      case 'summarizeThread':
        await this.questions.ask(
          msg.id,
          'Sum up this discussion on GitHub: what each person said, what is agreed, and what is still open.',
        );
        break;
      case 'draftReply':
        this.explain.draftReply(msg.id);
        break;
      case 'postReply':
        await vscode.commands.executeCommand('reviewDesk.github.postReply', msg.id, msg.body);
        break;
      case 'discardReply':
        this.controller.mutate((r) => {
          const a = r.annotations.find((x) => x.id === msg.id);
          if (a) delete a.reply;
        });
        break;
      case 'draftComment':
        await this.draftCommentAt(msg.target, msg.request);
        break;
      case 'editComment':
        if (this.editComment(msg.id, msg.body)) await this.controller.reload();
        break;
      case 'postComment':
        await vscode.commands.executeCommand('reviewDesk.github.postComment', msg.id);
        break;
      case 'error':
        log().error(`panel: ${msg.message}${msg.stack ? `\n${msg.stack}` : ''}`);
        break;
    }
  }

  /** A PR comment as the reviewer edited it; its title follows its first line. */
  editComment(id: string, body: string): boolean {
    const text = body.trim();
    if (!text) return false;
    const parsed = parseComment(text);
    return this.controller.mutate((r) => {
      const a = r.annotations.find((x) => x.id === id && x.kind === 'comment');
      if (!a) return;
      a.body = parsed.body;
      a.title = parsed.title;
    });
  }

  private resync(): void {
    this.citations = '';
    this.postState();
    this.host.post({ type: 'selection', selection: this.selection });
    this.host.post({ type: 'compose', target: this.composing });
    this.host.post({ type: 'githubCheck', check: this.githubCheck });
    this.host.post({ type: 'activeFile', info: this.activeFile });
    this.host.post({ type: 'currentFile', file: this.currentFile });
    if (this.activeId) this.host.post({ type: 'focus', id: this.activeId });
    for (const [cardId, a] of this.questions.answers)
      this.host.post({ type: 'answer', cardId, ...a });
    for (const [cardId, a] of this.explain.states)
      this.host.post({ type: 'explain', cardId, ...a });
    for (const [cardId, t] of this.translator.states)
      this.host.post({ type: 'translation', cardId, ...t });
    this.host.post({ type: 'summary', run: this.explain.summary ?? null });
  }

  private postState(): void {
    this.host.post({ type: 'state', state: this.panelState() });
    void this.postCitations();
  }

  private citations = '';

  /**
   * Checks the files and lines the AI cites in the summary, the notes and the answers, so
   * the panel links what exists and flags what does not.
   */
  private async postCitations(): Promise<void> {
    const { target, review, resolved } = this.controller;
    if (!target) return;
    const texts = [
      review?.overview ? splitSummary(review.overview).text : '',
      ...resolved.flatMap((a) => [
        a.body,
        ...(a.thread ?? []).filter((m) => m.from === 'ai').map((m) => m.body),
      ]),
    ];
    let map: Record<string, CitationView>;
    try {
      map = await checkCitations(target, citedPaths(texts));
    } catch {
      return;
    }
    if (this.controller.target !== target) return;
    const json = JSON.stringify(map);
    if (json === this.citations) return;
    this.citations = json;
    this.host.post({ type: 'citations', map });
  }

  private panelState(): PanelState | null {
    const { target, review, resolved, loadError } = this.controller;
    if (!target) return null;
    // Where each note posted to the pull request is: the review it went with.
    const postedAt = new Map(
      (review?.github?.posted ?? []).flatMap((p) => p.annotationIds.map((id) => [id, p.url])),
    );
    return {
      head: target.head.ref,
      base: target.base.ref,
      headSha: target.head.sha,
      uncommitted: target.uncommitted.length,
      files: target.files.map(filePath),
      overview: review?.overview,
      overviewStale: !!review?.overview && review.overviewOf !== diffDigest(target),
      overviewTranslatable: !!review && summaryNeedsTranslation(review, this.settings().language),
      error: loadError,
      cards: resolved.map((a) =>
        toCard(a, this.settings().language, postedAt.get(a.id), review?.github?.login),
      ),
      newReplies: resolved.reduce((n, a) => n + newReplies(a, review?.github?.login).length, 0),
      language: this.settings().language,
      viewed: Object.fromEntries(this.controller.viewed),
      pr: review?.github
        ? { number: review.github.number, title: review.github.title, url: review.github.url }
        : undefined,
      agent: this.agent?.info(),
    };
  }

  private async reveal(card: ResolvedAnnotation): Promise<void> {
    const target = this.controller.target;
    if (!target || !card.file) return;
    if (isFileNote(card)) {
      // A note on the whole file: show the file, where it is already open as it is.
      const uri = vscode.Uri.file(path.join(target.root, card.file)).toString();
      if (!vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri))
        await this.showCode(card.file, 1);
      return;
    }
    const range = new vscode.Range(card.resolvedStart - 1, 0, card.resolvedEnd - 1, 0);
    this.suppressFocusUntil = Date.now() + 800;
    const shown = vscode.window.visibleTextEditors.filter((e) =>
      annotationsForUri(target, this.controller.resolved, e.document.uri).some(
        (a) => a.id === card.id,
      ),
    );
    if (shown.length) {
      for (const e of shown)
        e.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    await this.showCode(card.file, card.resolvedStart, card.side);
  }

  /**
   * Opens code in the first editor group with the notes panel to its right. A panel that
   * ended up in the first group moves out only after the code is there: moving it out of a
   * group of its own would close that group, and the panel would be "group 1" again.
   */
  async inCodeColumn(
    open: (show: vscode.TextDocumentShowOptions) => Thenable<unknown>,
  ): Promise<void> {
    const panelHere = this.host.viewColumn === vscode.ViewColumn.One;
    // A preview tab would replace the panel while it shares the group.
    await open({ viewColumn: vscode.ViewColumn.One, preview: !panelHere });
    if (!panelHere) return;
    if (!vscode.window.tabGroups.all.some((g) => g.viewColumn === vscode.ViewColumn.Two)) {
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: 0.6 }, { size: 0.4 }],
      });
    }
    await this.host.moveTo(vscode.ViewColumn.Two);
  }

  /**
   * Shows a line of a review file in the code group: the working tree file itself (its changed
   * lines are highlighted and have handles), or the diff for a line that exists only in the
   * base.
   */
  private async showCode(file: string, at: number, side: Side = 'new'): Promise<void> {
    const target = this.controller.target;
    if (!target) return;
    // A citation like `a.ts:0` (or a file not there any more) is no line 0.
    const line = Math.max(1, Math.floor(at) || 1);
    const f = findFile(target, file);
    if (side === 'old' || f?.newPath === null) {
      await this.inCodeColumn((show) => openFileAt(target, file, line, show));
      return;
    }
    const uri = vscode.Uri.file(path.join(target.root, f?.newPath ?? file));
    await this.inCodeColumn((show) =>
      vscode.window.showTextDocument(uri, {
        ...show,
        preserveFocus: true,
        selection: new vscode.Range(line - 1, 0, line - 1, 0),
      }),
    );
  }

  /**
   * Picks the card under the upper third of the editor's visible area, unless it is the
   * card the reviewer closed.
   */
  focusFromEditor(editor: vscode.TextEditor): void {
    const target = this.controller.target;
    if (!target || Date.now() < this.suppressFocusUntil) return;
    const mine = annotationsForUri(target, this.controller.resolved, editor.document.uri);
    const visible = editor.visibleRanges[0];
    if (!mine.length || !visible) return;
    const top = visible.start.line + 1;
    const bottom = visible.end.line + 1;
    const anchor = top + Math.floor((bottom - top) / 3);
    const distance = (a: ResolvedAnnotation) =>
      anchor >= a.resolvedStart && anchor <= a.resolvedEnd
        ? 0
        : Math.min(Math.abs(a.resolvedStart - anchor), Math.abs(a.resolvedEnd - anchor));
    const inView = mine.filter((a) => a.resolvedEnd >= top && a.resolvedStart <= bottom);
    const best = inView.sort((a, b) => distance(a) - distance(b))[0];
    if (best && best.id !== this.activeId && best.id !== this.closedId) {
      this.activeId = best.id;
      this.closedId = undefined;
      this.controller.decorator.setActive(best.id);
      this.host.post({ type: 'focus', id: best.id });
    }
  }

  private trackSelection(editor: vscode.TextEditor): void {
    const rel = this.relativePath(editor.document.uri);
    if (rel === undefined) return;
    const sel = editor.selection;
    let selection: SelectionRef | null = null;
    if (!sel.isEmpty) {
      const endLine =
        sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      selection = { file: rel, startLine: sel.start.line + 1, endLine };
    }
    if (JSON.stringify(selection) === JSON.stringify(this.selection)) return;
    this.selection = selection;
    this.host.post({ type: 'selection', selection });
    // Other lines selected: the PR comment is drafted on those now.
    const c = this.composing;
    if (
      c &&
      selection &&
      !(
        c.side === 'new' &&
        c.file === selection.file &&
        c.startLine === selection.startLine &&
        c.endLine === selection.endLine
      )
    ) {
      this.composing = null;
      this.host.post({ type: 'compose', target: null });
    }
  }

  /** Switches the panel to an unchanged file while it is the active editor. */
  private async follow(editor: vscode.TextEditor): Promise<void> {
    const target = this.controller.target;
    const rel = this.relativePath(editor.document.uri);
    if (!target || rel === undefined) return;
    this.setCurrentFile(rel);
    if (findFile(target, rel)) {
      if (this.activeFile) {
        this.followSeq++;
        this.activeFile = null;
        this.host.post({ type: 'activeFile', info: null });
      }
      return;
    }
    const seq = ++this.followSeq;
    this.activeFile = { file: rel, uses: 'loading' };
    this.host.post({ type: 'activeFile', info: this.activeFile });
    const uses = await findUses(target, this.controller.resolved, editor.document.uri);
    if (seq !== this.followSeq) return;
    this.activeFile = { file: rel, uses };
    this.host.post({ type: 'activeFile', info: this.activeFile });
  }

  /** Repository-relative path of a working tree file, or undefined for anything else. */
  private relativePath(uri: vscode.Uri): string | undefined {
    const target = this.controller.target;
    if (!target || uri.scheme !== 'file') return undefined;
    const rel = path.relative(target.root, uri.fsPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return undefined;
    return rel;
  }

  dispose(): void {
    this.questions.dispose();
    this.explain.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** How much of a card the Claude Code chat wrote: the card itself and its chat messages. */
function chatMarks(a: ResolvedAnnotation): number {
  return (a.origin === 'chat' ? 1 : 0) + (a.thread ?? []).filter((m) => m.origin === 'chat').length;
}

/**
 * Selects lines of a document where it shows: the editor in front that has it (the right side
 * of its diff too, which then stays in front), else an editor opened for it.
 */
async function selectLines(uri: vscode.Uri, startLine: number, endLine: number): Promise<void> {
  const shown = (e: vscode.TextEditor | undefined) => e?.document.uri.toString() === uri.toString();
  const editor = shown(vscode.window.activeTextEditor)
    ? vscode.window.activeTextEditor!
    : (vscode.window.visibleTextEditors.find(shown) ??
      (await vscode.window.showTextDocument(uri, { preview: false })));
  const last = editor.document.lineAt(Math.min(endLine, editor.document.lineCount) - 1);
  editor.selection = new vscode.Selection(startLine - 1, 0, last.lineNumber, last.text.length);
  editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** The lines of an editor selection: the cursor's line when it is empty, without a last line it only reaches. */
export function selectedLines(sel: vscode.Selection): [number, number] {
  const startLine = sel.start.line + 1;
  const endLine = sel.isEmpty
    ? startLine
    : sel.end.character === 0 && sel.end.line > sel.start.line
      ? sel.end.line
      : sel.end.line + 1;
  return [startLine, endLine];
}

function toCard(a: ResolvedAnnotation, language: string, posted?: string, me?: string): CardView {
  return {
    id: a.id,
    number: a.number,
    kind: a.kind,
    kindLabel: KIND_LABELS[a.kind],
    title: a.title,
    body: a.body,
    file: a.file,
    side: a.side,
    startLine: a.resolvedStart,
    endLine: a.resolvedEnd,
    state: a.state,
    group: a.group,
    understood: a.understood ?? false,
    thread: a.thread ?? [],
    sourceUrl: a.source?.url,
    pending: a.pending,
    fromChat: a.origin === 'chat',
    translatable: needsTranslation(a, language),
    posted: a.postedAs?.url ?? posted,
    githubThread:
      a.source?.type === 'github' ||
      (!!a.postedAs && (a.thread ?? []).some((m) => m.githubId !== undefined)),
    newReplies: newReplies(a, me).length || undefined,
    reply: a.reply,
    resolved: a.threadResolved ? true : undefined,
    resolvedBy: a.threadResolved?.by,
  };
}

/** The active tab of a group that shows the file, if any. */
function activeTabShowing(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .map((g) => g.activeTab)
    .find(
      (t) => t?.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString(),
    );
}
