import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isFileNote, type Kind, type ResolvedAnnotation } from '../review/model';
import type { ReviewTarget } from '../review/target';
import { parseGitUri } from './gitApi';

export const KIND_COLORS: Record<Kind, string> = {
  overview: '#7c8b96',
  why: '#3f8ee8',
  how: '#23b07f',
  risk: '#e0662f',
  question: '#d4a72c',
  context: '#a87ff0',
  comment: '#db61a2',
};
const STALE_COLOR = '#8b8b8b';

/** Annotations that belong to a document: working tree files are the new side, base `git:` URIs the old. */
export function annotationsForUri(
  target: ReviewTarget,
  annotations: ResolvedAnnotation[],
  uri: vscode.Uri,
): ResolvedAnnotation[] {
  const rel = (fsPath: string) => path.relative(target.root, fsPath).split(path.sep).join('/');
  if (uri.scheme === 'file') {
    const file = rel(uri.fsPath);
    // A note on the whole file has no lines to mark.
    return annotations.filter((a) => a.side === 'new' && a.file === file && !isFileNote(a));
  }
  const g = parseGitUri(uri);
  if (g && g.ref === target.base.sha) {
    const oldPath = rel(g.path);
    return annotations.filter((a) => {
      if (a.side !== 'old') return false;
      const f = target.files.find((x) => x.newPath === a.file || x.oldPath === a.file);
      return (f?.oldPath ?? a.file) === oldPath;
    });
  }
  return [];
}

/** Numbered gutter badges and a colored bar along each annotation's lines. */
export class ReviewDecorator implements vscode.Disposable {
  private readonly badgeTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly rangeTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly activeType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
  });
  private target: ReviewTarget | undefined;
  private annotations: ResolvedAnnotation[] = [];
  private activeId: string | undefined;
  /** Decorated annotation count per document URI, for tests and the status bar. */
  readonly applied = new Map<string, number>();

  constructor(private readonly storage: vscode.Uri) {}

  set(target: ReviewTarget | undefined, annotations: ResolvedAnnotation[]): void {
    this.target = target;
    this.annotations = annotations;
    this.refresh();
  }

  /** Highlights the lines of the card selected in the panel. */
  setActive(id: string | undefined): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.refresh();
  }

  refresh(): void {
    this.applied.clear();
    for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
  }

  private decorate(editor: vscode.TextEditor): void {
    const mine = this.target
      ? annotationsForUri(this.target, this.annotations, editor.document.uri)
      : [];
    const badges = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
    const ranges = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
    const last = Math.max(editor.document.lineCount - 1, 0);

    for (const a of mine) {
      const start = Math.min(a.resolvedStart - 1, last);
      const end = Math.min(a.resolvedEnd - 1, last);
      const badge = this.badgeType(a.kind, a.number, a.state === 'stale');
      badges.set(badge, [
        ...(badges.get(badge) ?? []),
        { range: new vscode.Range(start, 0, start, 0), hoverMessage: `${a.number}. ${a.title}` },
      ]);
      const range = this.rangeType(a.state === 'stale' ? 'stale' : a.kind);
      ranges.set(range, [...(ranges.get(range) ?? []), new vscode.Range(start, 0, end, 0)]);
    }

    for (const type of [...this.badgeTypes.values(), ...this.rangeTypes.values()]) {
      editor.setDecorations(type, badges.get(type) ?? ranges.get(type) ?? []);
    }
    const active = mine.find((a) => a.id === this.activeId);
    editor.setDecorations(
      this.activeType,
      active
        ? [
            new vscode.Range(
              Math.min(active.resolvedStart - 1, last),
              0,
              Math.min(active.resolvedEnd - 1, last),
              0,
            ),
          ]
        : [],
    );
    if (mine.length) {
      const key = editor.document.uri.toString();
      this.applied.set(key, (this.applied.get(key) ?? 0) + mine.length);
    }
  }

  private badgeType(kind: Kind, n: number, stale: boolean): vscode.TextEditorDecorationType {
    const key = `${kind}-${n}${stale ? '-stale' : ''}`;
    let type = this.badgeTypes.get(key);
    if (!type) {
      type = vscode.window.createTextEditorDecorationType({
        gutterIconPath: this.badgeIcon(key, stale ? STALE_COLOR : KIND_COLORS[kind], n),
        gutterIconSize: 'contain',
      });
      this.badgeTypes.set(key, type);
    }
    return type;
  }

  private rangeType(kind: Kind | 'stale'): vscode.TextEditorDecorationType {
    let type = this.rangeTypes.get(kind);
    if (!type) {
      const color = kind === 'stale' ? STALE_COLOR : KIND_COLORS[kind];
      type = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: '0 0 0 2px',
        borderStyle: kind === 'stale' ? 'dashed' : 'solid',
        borderColor: color,
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
      this.rangeTypes.set(kind, type);
    }
    return type;
  }

  private badgeIcon(key: string, color: string, n: number): vscode.Uri {
    const file = vscode.Uri.joinPath(this.storage, 'badges', `${key}.svg`);
    if (!fs.existsSync(file.fsPath)) {
      fs.mkdirSync(path.dirname(file.fsPath), { recursive: true });
      const size = n > 9 ? 8 : 10;
      fs.writeFileSync(
        file.fsPath,
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
          `<circle cx="8" cy="8" r="7.5" fill="${color}"/>` +
          `<text x="8" y="8" dy="0.36em" text-anchor="middle" font-family="sans-serif" ` +
          `font-size="${size}" font-weight="700" fill="#fff">${n}</text></svg>`,
      );
    }
    return file;
  }

  dispose(): void {
    this.activeType.dispose();
    for (const t of [...this.badgeTypes.values(), ...this.rangeTypes.values()]) t.dispose();
    this.badgeTypes.clear();
    this.rangeTypes.clear();
  }
}
