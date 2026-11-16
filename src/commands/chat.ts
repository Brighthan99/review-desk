import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { repoRoot } from '../review/target';
import type { Command, Services } from './services';
import { errorText, showError, showWarning } from '../ui/log';

/** The repository the Claude Code chat reads the notes of: the review's, else the editor's. */
export async function chatRoot(controller: ReviewController): Promise<string | undefined> {
  const cwd = controller.target?.root ?? controller.workspaceCwd();
  return cwd ? repoRoot(cwd).catch(() => undefined) : undefined;
}

/**
 * Where chats about it start: the repository, and the folder this window's Claude Code chat
 * starts in, the first workspace folder (another repository in a multi-root workspace).
 */
export async function chatPlaces(root: string): Promise<string[]> {
  const first = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const chatFolder = first && (await repoRoot(first).catch(() => first));
  return [...new Set([root, chatFolder].filter((p): p is string => !!p))];
}

const names = (places: string[]) => places.map((p) => path.basename(p)).join(' and ');

/** Connecting the Claude Code chat to the notes. */
export function registerChatCommands(command: Command, s: Services): void {
  const { controller, chat } = s;
  command('reviewDesk.connectChat', async () => {
    const root = await chatRoot(controller);
    if (!root) {
      showWarning('Review Desk: open a git repository first.');
      return false;
    }
    const places = await chatPlaces(root);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Review Desk: connecting the Claude Code chat…',
        },
        () => chat.connect(root, places),
      );
    } catch (e) {
      showError(`Review Desk: could not connect the Claude Code chat. ${errorText(e)}`, e);
      return false;
    }
    const of = places.length > 1 ? ` of ${path.basename(root)}` : '';
    void vscode.window.showInformationMessage(
      `Review Desk: Claude Code chats in ${names(places)} can now read the review notes${of}. Start a new chat to use them.`,
    );
    return true;
  });
  command('reviewDesk.disconnectChat', async () => {
    const root = await chatRoot(controller);
    const connected = root ? chat.connectedPlaces(root, await chatPlaces(root)) : [];
    if (!root || !connected.length) {
      void vscode.window.showInformationMessage(
        'Review Desk: the Claude Code chat is not connected here.',
      );
      return false;
    }
    try {
      await chat.disconnect(root, connected);
    } catch (e) {
      showError(`Review Desk: could not disconnect the Claude Code chat. ${errorText(e)}`, e);
      return false;
    }
    void vscode.window.showInformationMessage(
      `Review Desk: Claude Code chats in ${names(connected)} no longer read the review notes.`,
    );
    return true;
  });
}
