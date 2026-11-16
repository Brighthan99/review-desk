import { fenced, markdownText } from '../shared/markdownText';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { changeBlocks, type ChangeBlock } from '../review/blocks';
import type { DiffFile } from '../review/diffParser';
import { TRIVIAL_LABELS, triviaOf } from '../review/trivial';
import { setting } from '../settings';

/** Commands the hover links may run. */
const MAX_DELETED_IN_HOVER = 12;

/**
 * Makes command links for a hover and keeps which commands they run: a hover runs only the
 * commands it trusts by name, and a link to one left out does nothing when clicked.
 */
function linker() {
  const commands = new Set<string>();
  const link = (title: string, command: string, args: unknown[]) => {
    commands.add(command);
    return `[${title}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
  };
  return { link, commands };
}

/** Whether the document shows as the right side of a diff in front in some group: its diff already. */
function inFrontDiff(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((g) => {
    const input = g.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && input.modified.toString() === uri.toString();
  });
}
const lines = (start: number, end: number) => (start === end ? `${start}` : `${start}–${end}`);
const EXPLAIN_KEY = process.platform === 'darwin' ? '⌘⌥E' : 'Ctrl+Alt+E';
const TRIVIAL_TOOLTIP =
  'Nothing to read line by line here: only whitespace, code moved from elsewhere in the change, import lines, or a generated file. Faded (reviewDesk.dimTrivialChanges).';

/**
 * Handles on the changed blocks of a working tree file in the open review, so a change can be
 * explained without selecting it: a CodeLens above each block, a hover with the same
 * actions, a hint at the end of the cursor line inside a block, and (outside diff editors)
 * the changed lines highlighted against the base.
 */
export class ChangeHandles implements vscode.CodeLensProvider, vscode.HoverProvider {
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly blockCache = new WeakMap<DiffFile, ChangeBlock[]>();
  private readonly addedType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly deletedType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '1px 0 0 0',
    borderStyle: 'dashed',
    borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  /** Changed lines with nothing to read (whitespace, moved code, imports, generated): faded. */
  private readonly trivialType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    opacity: '0.55',
    overviewRulerColor: new vscode.ThemeColor('editorLineNumber.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly hintType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 3em',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  /** Highlighted block count per document URI, for tests. */
  readonly highlighted = new Map<string, number>();
  /** The hint shown at the end of the cursor line, for tests. */
  hint: { uri: string; line: number; text: string } | undefined;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly controller: ReviewController) {
    const selector: vscode.DocumentSelector = { scheme: 'file' };
    const changed = () => {
      this.lensesChanged.fire();
      this.refresh();
    };
    this.disposables = [
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerHoverProvider(selector, this),
      controller.onDidChange(() => {
        changed();
        this.updateHint();
      }),
      vscode.window.onDidChangeTextEditorSelection(() => this.updateHint()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateHint()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('reviewDesk')) changed();
      }),
      this.lensesChanged,
      this.addedType,
      this.deletedType,
      this.trivialType,
      this.hintType,
    ];
  }

  /** The block of added lines that contains a line of a working tree file, if any. */
  blockAt(uri: vscode.Uri, line: number): ChangeBlock | undefined {
    return this.changesOf(uri)?.blocks.find(
      (b) => b.side === 'new' && b.newStart <= line && line <= b.newEnd,
    );
  }

  /**
   * With the cursor inside a changed block (nothing selected), says at the end of the line
   * that the shortcut explains the block, or names the note already written for it.
   */
  private updateHint(): void {
    const editor = vscode.window.activeTextEditor;
    this.updateChangedContext(editor);
    const previous = this.hint;
    this.hint = undefined;
    if (editor && editor.selection.isEmpty && setting('inlineHint')) {
      const line = editor.selection.active.line + 1;
      const b = this.blockAt(editor.document.uri, line);
      const rel = b && this.relative(editor.document.uri);
      if (b && rel) {
        const card = this.cardFor(rel, b);
        const text = !card
          ? `✦ Explain this block  ${EXPLAIN_KEY}`
          : card.pending
            ? '✦ Writing a note on this block…'
            : `✦ ${card.number}. ${card.title.slice(0, 60)}  ${EXPLAIN_KEY}`;
        this.hint = { uri: editor.document.uri.toString(), line, text };
      }
    }
    if (JSON.stringify(previous) === JSON.stringify(this.hint)) return;
    for (const e of vscode.window.visibleTextEditors) {
      const mine = this.hint && e === editor;
      const end = mine ? e.document.lineAt(this.hint!.line - 1).range.end : undefined;
      e.setDecorations(
        this.hintType,
        mine && end
          ? [
              {
                range: new vscode.Range(end, end),
                renderOptions: { after: { contentText: this.hint!.text } },
              },
            ]
          : [],
      );
    }
  }

  private relative(uri: vscode.Uri): string | undefined {
    const target = this.controller.target;
    if (!target || uri.scheme !== 'file') return undefined;
    const rel = path.relative(target.root, uri.fsPath).split(path.sep).join('/');
    return rel && !rel.startsWith('..') ? rel : undefined;
  }

  /**
   * The changed file a document shows, with its blocks and, per block, why it needs no
   * reading (when `reviewDesk.dimTrivialChanges` is on).
   */
  private changesOf(
    uri: vscode.Uri,
  ): { file: DiffFile; blocks: ChangeBlock[]; trivial: (string | undefined)[] } | undefined {
    const rel = this.relative(uri);
    const target = this.controller.target!;
    const file = rel && target.files.find((f) => f.newPath === rel);
    if (!file || file.binary) return undefined;
    let blocks = this.blockCache.get(file);
    if (!blocks) {
      blocks = changeBlocks(file);
      this.blockCache.set(file, blocks);
    }
    const trivia = setting('dimTrivialChanges') ? triviaOf(target).get(rel) : undefined;
    const trivial = blocks.map((_, i) =>
      trivia?.label === 'generated'
        ? 'generated file'
        : trivia?.blocks[i] && TRIVIAL_LABELS[trivia.blocks[i]],
    );
    return { file, blocks, trivial };
  }

  /** The note already written for a block, if any. */
  private cardFor(file: string, b: ChangeBlock) {
    return this.controller.resolved.find(
      (a) =>
        a.file === file &&
        a.kind !== 'question' &&
        a.kind !== 'comment' &&
        a.side === b.side &&
        a.resolvedStart <= b.end &&
        a.resolvedEnd >= b.start,
    );
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!setting('codeLens')) return [];
    const changes = this.changesOf(doc.uri);
    if (!changes) return [];
    const uri = doc.uri.toString();
    const file = changes.file.newPath!;
    const isNew = changes.file.status === 'added';
    return changes.blocks.flatMap((b, i) => {
      const range = new vscode.Range(b.newStart - 1, 0, b.newStart - 1, 0);
      const trivial = changes.trivial[i];
      const card = this.cardFor(file, b);
      const what = isNew
        ? 'this new file'
        : b.side === 'new'
          ? `lines ${lines(b.start, b.end)}`
          : `${b.deleted.length} deleted lines`;
      return [
        ...(isNew
          ? [new vscode.CodeLens(range, { title: this.newFileLabel(file, b), command: '' })]
          : []),
        ...(trivial
          ? [
              new vscode.CodeLens(range, {
                title: `$(circle-slash) ${trivial}`,
                tooltip: TRIVIAL_TOOLTIP,
                command: '',
              }),
            ]
          : []),
        new vscode.CodeLens(
          range,
          card
            ? {
                title: `$(review-desk-logo) ${card.number}. ${card.title.slice(0, 60)}`,
                command: 'reviewDesk.selectCard',
                arguments: [card.id],
              }
            : {
                title: '$(review-desk-logo) Explain',
                tooltip: `Ask AI to explain ${what}`,
                command: 'reviewDesk.explainRange',
                arguments: [uri, b.start, b.end, b.side],
              },
        ),
        new vscode.CodeLens(range, {
          title: 'Ask',
          tooltip: `Ask AI about ${what}`,
          command: 'reviewDesk.askAboutRange',
          arguments: [uri, b.newStart, b.newEnd],
        }),
        new vscode.CodeLens(range, {
          title: 'Comment',
          tooltip: `Ask AI to draft a PR comment on ${what}, to edit and post`,
          command: 'reviewDesk.draftCommentRange',
          arguments: [uri, b.start, b.end, b.side],
        }),
        ...(isNew
          ? []
          : [
              new vscode.CodeLens(range, {
                title: 'Diff',
                tooltip: 'Show the diff against the base (Show File turns it back)',
                command: 'reviewDesk.showDiff',
                arguments: [uri, b.newStart],
              }),
            ]),
      ];
    });
  }

  /** "New file · 62 lines · uncommitted": every line of an added file is new. */
  private newFileLabel(file: string, b: ChangeBlock): string {
    const count = `${b.added} ${b.added === 1 ? 'line' : 'lines'}`;
    const uncommitted = this.controller.target!.uncommitted.includes(file);
    return `New file · ${count}${uncommitted ? ' · uncommitted' : ''}`;
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const rel = this.relative(doc.uri);
    if (!rel) return undefined;
    const line = pos.line + 1;
    const parts: string[] = [];
    const { link, commands } = linker();
    for (const a of this.controller.resolved) {
      if (a.file === rel && a.side === 'new' && a.resolvedStart <= line && line <= a.resolvedEnd) {
        parts.push(
          link(
            `$(review-desk-logo) ${a.number}. ${markdownText(a.title)}`,
            'reviewDesk.selectCard',
            [a.id],
          ),
        );
      }
    }
    const changes = setting('hover') ? this.changesOf(doc.uri) : undefined;
    const b = changes?.blocks.find((x) => x.newStart <= line && line <= x.newEnd);
    if (b) {
      const uri = doc.uri.toString();
      const isNew = changes!.file.status === 'added';
      const actions = [
        this.cardFor(rel, b)
          ? undefined
          : link('$(review-desk-logo) Explain', 'reviewDesk.explainRange', [
              uri,
              b.start,
              b.end,
              b.side,
            ]),
        link('Ask', 'reviewDesk.askAboutRange', [uri, b.newStart, b.newEnd]),
        link('Comment', 'reviewDesk.draftCommentRange', [uri, b.start, b.end, b.side]),
        // In the diff of the file already: back to the file instead.
        isNew
          ? undefined
          : inFrontDiff(doc.uri)
            ? link('Show File', 'reviewDesk.showFile', [uri])
            : link('Diff', 'reviewDesk.showDiff', [uri, b.newStart]),
        link('Summarize File', 'reviewDesk.summarizeFile', [uri]),
      ].filter(Boolean);
      const what = isNew
        ? this.newFileLabel(rel, b)
        : b.side === 'new'
          ? `Changed lines ${lines(b.start, b.end)}`
          : `${b.deleted.length} deleted ${b.deleted.length === 1 ? 'line' : 'lines'} above`;
      const trivial = changes!.trivial[changes!.blocks.indexOf(b)];
      parts.push(
        `**Review Desk** · ${what}${trivial ? ` · ${trivial}` : ''} · ${actions.join(' · ')}`,
      );
      if (b.deleted.length) {
        const shown = b.deleted.slice(0, MAX_DELETED_IN_HOVER);
        const more = b.deleted.length - shown.length;
        parts.push(fenced(shown.join('\n'), doc.languageId) + (more ? `\n…${more} more` : ''));
      }
    }
    if (!parts.length) return undefined;
    const md = new vscode.MarkdownString(parts.join('\n\n'), true);
    md.isTrusted = { enabledCommands: [...commands] };
    return new vscode.Hover(md);
  }

  private changedContext: boolean | undefined;
  private viewContext: string | undefined;

  /**
   * Whether the editor in front is a changed file with a diff to show (Show Diff button), and
   * whether that changed file is marked viewed (the Viewed button).
   */
  private updateChangedContext(editor: vscode.TextEditor | undefined): void {
    const changes =
      editor && !inDiffEditor(editor) ? this.changesOf(editor.document.uri) : undefined;
    const changed = !!changes && changes.file.status !== 'added';
    if (changed !== this.changedContext) {
      this.changedContext = changed;
      void vscode.commands.executeCommand('setContext', 'reviewDesk.activeFileChanged', changed);
    }
    const rel = editor && this.relative(editor.document.uri);
    const inReview = !!rel && this.controller.target!.files.some((f) => f.newPath === rel);
    const view = !inReview
      ? ''
      : this.controller.viewed.get(rel) === 'viewed'
        ? 'viewed'
        : 'unviewed';
    if (view === this.viewContext) return;
    this.viewContext = view;
    void vscode.commands.executeCommand('setContext', 'reviewDesk.activeFileView', view);
  }

  /** Highlights changed lines in plain editors (diff editors already show them). */
  refresh(): void {
    this.highlighted.clear();
    const on = setting('highlightChanges');
    for (const editor of vscode.window.visibleTextEditors) {
      const changes = on && !inDiffEditor(editor) ? this.changesOf(editor.document.uri) : undefined;
      // A new file is highlighted whole, as a PR diff shows it. Blocks with nothing to read
      // are faded instead.
      const blocks = changes?.blocks ?? [];
      const span = (b: ChangeBlock) => new vscode.Range(b.newStart - 1, 0, b.newEnd - 1, 0);
      const added = blocks.filter((b, i) => b.side === 'new' && !changes!.trivial[i]).map(span);
      const trivial = blocks.filter((b, i) => b.side === 'new' && changes!.trivial[i]).map(span);
      const deleted = blocks
        .filter((b) => b.side === 'old')
        .map((b) => new vscode.Range(b.newStart - 1, 0, b.newStart - 1, 0));
      editor.setDecorations(this.addedType, added);
      editor.setDecorations(this.trivialType, trivial);
      editor.setDecorations(this.deletedType, deleted);
      if (blocks.length) this.highlighted.set(editor.document.uri.toString(), blocks.length);
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Whether an editor is one side of a diff editor (or inside the multi-file diff editor). */
function inDiffEditor(editor: vscode.TextEditor): boolean {
  if (editor.viewColumn === undefined) return true;
  const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === editor.viewColumn);
  const input = group?.activeTab?.input;
  if (input instanceof vscode.TabInputTextDiff) return true;
  return typeof input === 'object' && input !== null && 'textDiffs' in input;
}
