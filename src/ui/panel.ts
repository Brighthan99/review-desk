import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { FromPanel, ToPanel } from '../shared/protocol';

export const PANEL_VIEW_TYPE = 'reviewDesk.panel';

/** Hosts the explanation panel webview and queues messages until it says it is ready. */
export class PanelHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queue: ToPanel[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly shown = new vscode.EventEmitter<void>();
  /** Fires whenever the panel (re)starts and wants the full state. */
  readonly onDidBecomeReady = this.shown.event;
  private readonly posted = new vscode.EventEmitter<ToPanel>();
  /** Every message sent to the panel (used by tests). */
  readonly onDidPost = this.posted.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (msg: FromPanel) => void,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
        // A review may have opened a panel before VS Code brings the old one back (extensions
        // restart when a folder is added to a window of one): one is enough.
        deserializeWebviewPanel: async (panel) =>
          this.panel ? panel.dispose() : this.attach(panel),
      }),
    );
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isVisible(): boolean {
    return this.panel?.visible ?? false;
  }

  /** The editor group the panel is in, while it is open. */
  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel?.viewColumn;
  }

  /**
   * Moves the open panel to another editor group, leaving the focus where it is. Resolves
   * once it has moved (or after a second), so code opened next cannot land on top of it.
   */
  async moveTo(column: vscode.ViewColumn): Promise<void> {
    const panel = this.panel;
    if (!panel || panel.viewColumn === column) return;
    const moved = new Promise<void>((resolve) => {
      const done = () => {
        sub.dispose();
        clearTimeout(timer);
        resolve();
      };
      const sub = panel.onDidChangeViewState(() => panel.viewColumn === column && done());
      const timer = setTimeout(done, 1000);
    });
    panel.reveal(column, true);
    await moved;
  }

  /**
   * Opens the panel beside the current editor group, or reveals it. A panel sharing the
   * active editor's group would cover the code just asked about, so it moves beside it.
   */
  show(preserveFocus = true): void {
    if (this.panel) {
      const editor = vscode.window.activeTextEditor?.viewColumn;
      const covers = editor !== undefined && this.panel.viewColumn === editor;
      this.panel.reveal(covers ? vscode.ViewColumn.Beside : undefined, preserveFocus);
      return;
    }
    // A tab VS Code kept from before a reload or a restart of the extensions, not brought
    // back yet (it waits until shown): this panel takes its place.
    const stale = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(PANEL_VIEW_TYPE),
      );
    if (stale.length) void vscode.window.tabGroups.close(stale, true);
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'Review Desk',
      { viewColumn: stale[0]?.group.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.webviewRoot()],
      },
    );
    this.attach(panel);
  }

  post(msg: ToPanel): void {
    this.posted.fire(msg);
    if (this.panel && this.ready) {
      void this.panel.webview.postMessage(msg);
      return;
    }
    // No panel: nothing kept. Opening, it is sent all it shows (resync), so a queue would only
    // grow, with every streamed chunk's whole text, while it stays closed.
    if (!this.panel) return;
    // Loading: only the latest full state, and the latest text of each card's stream.
    if (msg.type === 'state') this.queue = this.queue.filter((m) => m.type !== 'state');
    if (msg.type === 'answer' || msg.type === 'explain') {
      this.queue = this.queue.filter((m) => !(m.type === msg.type && m.cardId === msg.cardId));
    }
    this.queue.push(msg);
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.ready = false;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'logo-color.svg');
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.webviewRoot()] };
    panel.webview.html = this.html(panel.webview);
    const subs = [
      panel.webview.onDidReceiveMessage((msg: FromPanel) => {
        if (msg.type === 'ready') {
          this.ready = true;
          const queued = this.queue;
          this.queue = [];
          this.shown.fire();
          for (const m of queued) void panel.webview.postMessage(m);
          return;
        }
        this.onMessage(msg);
      }),
      panel.onDidDispose(() => {
        subs.forEach((d) => d.dispose());
        if (this.panel === panel) {
          this.panel = undefined;
          this.ready = false;
        }
      }),
    ];
  }

  private webviewRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.webviewRoot(), name));
    const csp = [
      "default-src 'none'",
      // Inline styles too: the diagrams Mermaid draws carry their own <style>.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // Images only from the extension, inline, and GitHub (screenshots in review comments):
      // an image from any other address could carry what the agent read out to that host,
      // or tell someone a comment was read.
      `img-src ${webview.cspSource} data: https://github.com https://*.githubusercontent.com`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('main.css')}">
<title>Review Desk</title>
</head>
<body data-mermaid="${asset('mermaid.js')}">
<div id="root"></div>
<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.shown.dispose();
    this.posted.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
