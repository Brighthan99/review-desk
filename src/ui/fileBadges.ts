import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';

/** Shows the number of AI explanations next to files in the Explorer. */
export class FileBadges implements vscode.FileDecorationProvider, vscode.Disposable {
  private counts = new Map<string, number>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly controller: ReviewController) {
    this.subscriptions = [
      vscode.window.registerFileDecorationProvider(this),
      controller.onDidChange(() => this.update()),
    ];
  }

  private update(): void {
    const target = this.controller.target;
    const counts = new Map<string, number>();
    if (target) {
      for (const a of this.controller.resolved) {
        if (!a.file || a.side !== 'new') continue;
        const key = vscode.Uri.file(path.join(target.root, a.file)).toString();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const touched = new Set([...this.counts.keys(), ...counts.keys()]);
    this.counts = counts;
    this.changed.fire([...touched].map((k) => vscode.Uri.parse(k)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const n = this.counts.get(uri.toString());
    if (!n) return undefined;
    return new vscode.FileDecoration(
      n > 99 ? '99' : String(n),
      `${n} AI ${n === 1 ? 'note' : 'notes'}`,
    );
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.changed.dispose();
  }
}
