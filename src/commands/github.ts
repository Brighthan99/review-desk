import * as vscode from 'vscode';
import type { ReviewEvent } from '../github/convert';
import type { Command, Services } from './services';
import { errorText, showError } from '../ui/log';

/** Fetching the remotes, and GitHub pull requests: opening, importing threads, posting notes. */
export function registerGitHubCommands(command: Command, s: Services): void {
  const { controller, github, prompts } = s;
  // The review a checkout into a worktree left for a folder of this window (not listed).
  command('reviewDesk.resumePending', (folders?: string[]) => github.resumePending(folders));
  // Fetches the remotes so the comparison sees where the branches are on GitHub now.
  command('reviewDesk.fetch', async () => {
    const changes = await prompts.progress('Fetching…', () =>
      controller.fetchRemotes().catch((e: unknown) => {
        showError(`Review Desk: git fetch failed. ${errorText(e)}`, e);
        return null;
      }),
    );
    if (changes === null) return undefined;
    if (changes === undefined) {
      void vscode.window.showInformationMessage('Review Desk: open a git repository first.');
      return undefined;
    }
    const pr = await github.checkState().catch(() => undefined);
    const replies = await github.checkReplies('fetch');
    const what = changes.length ? `fetched: ${changes.join(', ')}.` : 'already up to date.';
    void vscode.window.showInformationMessage(
      `Review Desk: ${what}${pr ? ` ${pr}` : ''}${replies ? ` ${replies} new ${replies === 1 ? 'reply' : 'replies'} on GitHub.` : ''}`,
    );
    return changes;
  });
  // A reply in a note's GitHub thread, from the panel (after a yes).
  command('reviewDesk.github.postReply', (id: string, body: string) => github.postReply(id, body));
  // The notes panel's Sync button: the pull request read on GitHub now.
  command('reviewDesk.github.sync', () => github.syncNow());
  // The first note with new GitHub replies, in the panel.
  command('reviewDesk.showNewReplies', () => s.panel.showNewReplies());
  command('reviewDesk.github.open', () => github.open());
  command('reviewDesk.github.postAs', (uri: string, event?: ReviewEvent) =>
    github.postAs(uri, event),
  );
  command('reviewDesk.github.openUrl', (address?: unknown) =>
    github.openUrl(typeof address === 'string' ? address : undefined),
  );
  command('reviewDesk.github.importThreads', async () => {
    const n = await github.importThreads();
    if (n)
      void vscode.window.showInformationMessage(
        `Review Desk: imported ${n} GitHub review ${n === 1 ? 'thread' : 'threads'}.`,
      );
  });
  command('reviewDesk.github.post', () => github.post());
  // A PR comment card's Post to PR button: that comment alone.
  command('reviewDesk.github.postComment', (id: string) => github.postComment(id));
}
