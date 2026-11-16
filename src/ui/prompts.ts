import * as vscode from 'vscode';
import { samePath } from '../review/realpath';
import type { Repo } from '../review/repos';
import type { ReviewTarget } from '../review/target';
import type { AgentKind, AgentStatus } from '../shared/agentUse';
import { askAgent, type AgentPick } from './agentPick';
import { askFolder } from './folders';
import { showWarning } from './log';
import { askSide, type SidePick } from './compareSides';
import { askMenu, type MenuItem } from './menu';
import { askPlace, type Place, type PlaceQuestion } from './place';
import { askPull, type PullListing, type PullPick } from './pullPick';

/** The Review list's view, whose progress bar shows while Review Desk is busy with the review. */
export const LIST_VIEW = 'reviewDesk.files';

/**
 * What Review Desk asks or shows the reviewer outside its own views: modal questions,
 * warnings, new windows, where to check something out, progress. One object for every
 * service, so tests answer for the reviewer in one place (`api.prompts`), and put it back
 * after.
 */
export interface Prompts {
  /** A modal question with one button; true when the reviewer pressed it. */
  confirm(message: string, button: string, detail?: string): Promise<boolean>;
  /** A modal question with several buttons: the one pressed, undefined when dismissed. */
  choose(message: string, buttons: string[], detail?: string): Promise<string | undefined>;
  /** A warning the reviewer reads; nothing to answer. */
  warn(message: string): void;
  /** Opens a folder in a new window. */
  openFolder(dir: string): Promise<void>;
  /**
   * Adds a folder to this window, after the ones it has. A window of one folder becomes a
   * workspace of several, and its extensions restart (Review Desk too).
   */
  addFolder(dir: string): Promise<void>;
  /**
   * Takes a folder out of this window. The window's first folder restarts its extensions
   * (Review Desk too), so callers do it last.
   */
  removeFolder(dir: string): Promise<void>;
  /** Closes this window. */
  closeWindow(): Promise<void>;
  /** Where to check a branch or commit out: here, or in a worktree (a new window, or added). */
  pickPlace(question: PlaceQuestion): Promise<Place | undefined>;
  /**
   * Which side of the comparison to change (the comparison row), or a pull request to
   * review instead (its address pasted in).
   */
  pickSide(target: ReviewTarget | undefined): Promise<SidePick | undefined>;
  /**
   * Which pull request to review: an open one of the repository here (`load` lists them,
   * asked to sign in only when the reviewer picks that), or any one by its address.
   */
  pickPull(load: (signIn: boolean) => Promise<PullListing>): Promise<PullPick | undefined>;
  /** What to do, from the Review Desk menu (the list's ☰ button, the status bar item). */
  pickMenu(items: MenuItem[]): Promise<MenuItem | undefined>;
  /**
   * Which agent writes the notes (Claude Code, Codex), each shown with how it stands as `load`
   * tells (installed, signed in, which account); or 'about'.
   */
  pickAgent(current: AgentKind, load: () => Promise<AgentStatus[]>): Promise<AgentPick | undefined>;
  /** Which of the window's repositories to review (`current`: the one reviewed now). */
  pickFolder(repos: Repo[], current?: string): Promise<Repo | undefined>;
  /**
   * Runs `task` with the progress bar of the Review list showing (`title` on hover): a
   * switch, a fetch, the review computed again. Never around a question to the reviewer.
   */
  progress<T>(title: string, task: () => Promise<T>): Promise<T>;
}

export function defaultPrompts(): Prompts {
  return {
    confirm: async (message, button, detail) =>
      (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button,
    choose: async (message, buttons, detail) =>
      vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons),
    warn: (message) => showWarning(message),
    openFolder: async (dir) => {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), {
        forceNewWindow: true,
      });
    },
    addFolder: async (dir) => {
      const n = vscode.workspace.workspaceFolders?.length ?? 0;
      if (!vscode.workspace.updateWorkspaceFolders(n, 0, { uri: vscode.Uri.file(dir) })) {
        throw new Error(`VS Code did not add ${dir} to this window.`);
      }
    },
    removeFolder: async (dir) => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const i = folders.findIndex((f) => samePath(f.uri.fsPath, dir));
      if (i >= 0) vscode.workspace.updateWorkspaceFolders(i, 1);
    },
    closeWindow: async () => {
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    },
    pickPlace: askPlace,
    pickFolder: askFolder,
    pickAgent: askAgent,
    pickSide: askSide,
    pickPull: askPull,
    pickMenu: askMenu,
    progress: (title, task) =>
      Promise.resolve(vscode.window.withProgress({ location: { viewId: LIST_VIEW }, title }, task)),
  };
}
