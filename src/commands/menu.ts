import * as vscode from 'vscode';
import { menuItems } from '../ui/menu';
import { language } from '../settings';
import { chatPlaces, chatRoot } from './chat';
import type { Command, Services } from './services';

/** The Review Desk menu: the Review list's ☰ button and the status bar item. */
export function registerMenuCommands(command: Command, s: Services): void {
  const { controller, tree, chat, prompts } = s;
  command('reviewDesk.showActions', async () => {
    const root = await chatRoot(controller);
    const connected = root ? chat.connectedPlaces(root, await chatPlaces(root)) : [];
    const picked = await prompts.pickMenu(
      menuItems({
        active: !!controller.target,
        mode: tree.mode,
        hasReadingOrder: tree.hasReadingOrder,
        showAll: tree.showAll,
        hideViewed: tree.hideViewed,
        chatConnected: connected.length > 0,
        severalFolders: (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
        language: language(),
        loadError: controller.loadError,
      }),
    );
    return picked?.command ? vscode.commands.executeCommand(picked.command) : undefined;
  });
}
