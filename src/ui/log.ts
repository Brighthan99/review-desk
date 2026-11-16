import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/**
 * Review Desk's log (Output → Review Desk, also saved with VS Code's logs), to find what went
 * wrong from a reviewer's report: errors and warnings shown with their causes, commands that
 * failed, claude runs, git commands that failed or were slow (Debug level), what made the
 * review refresh. Never the code or the prompts.
 */
export function log(): vscode.LogOutputChannel {
  return (channel ??= vscode.window.createOutputChannel('Review Desk', { log: true }));
}

/**
 * Logs a list being filled again soon after the last time (`ms`), which only a refresh loop
 * does; ordinary refreshes are not logged.
 */
export function logRapid(list: string, ms = 2000): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < ms) log().info(`${list} list refreshed again after ${now - last} ms`);
    last = now;
  };
}

const SHOW_LOG = 'Show Log';

/** An error's message, for a sentence shown to the reviewer. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `message`, then what caused it: an error's stack (git's stderr is in its message). */
function withCause(message: string, cause: unknown): string {
  if (cause === undefined) return message;
  const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  return `${message}\n${detail}`;
}

function offerLog(shown: Thenable<string | undefined>): void {
  void shown.then((picked) => picked === SHOW_LOG && log().show(true));
}

/** Shows an error and logs it with its cause; "Show Log" opens the log. */
export function showError(message: string, cause?: unknown): void {
  log().error(withCause(message, cause));
  offerLog(vscode.window.showErrorMessage(message, SHOW_LOG));
}

/** Shows a warning and logs it; with a cause (something failed), "Show Log" opens the log. */
export function showWarning(message: string, cause?: unknown): void {
  log().warn(withCause(message, cause));
  offerLog(vscode.window.showWarningMessage(message, ...(cause === undefined ? [] : [SHOW_LOG])));
}
