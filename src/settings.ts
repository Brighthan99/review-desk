import * as vscode from 'vscode';
import { languageName } from './shared/languageName';

/**
 * Review Desk's settings by name, with their types. Their defaults are package.json's
 * (`contributes.configuration`), which VS Code fills in: none is repeated here, so the two
 * never disagree. A unit test checks this list against package.json, and that every setting
 * there has a default.
 */
export interface Settings {
  baseRef: string;
  language: string;
  commentLanguage: string;
  includeUncommitted: boolean;
  codeLens: boolean;
  hover: boolean;
  inlineHint: boolean;
  highlightChanges: boolean;
  notifyBranchSwitch: boolean;
  dimTrivialChanges: boolean;
  diffOpensIn: 'sameTab' | 'newTab';
  showCommentThreads: boolean;
  openPanelOnStart: boolean;
  agent: 'claude' | 'codex';
  claudePath: string;
  codexPath: string;
  model: string;
  codexModel: string;
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxBudgetUsd: number;
  summaryMaxBudgetUsd: number;
  summaryReadingOrder: boolean;
  summaryDiagram: boolean;
  maxConcurrentQuestions: number;
  githubCheckMinutes: number;
}

/**
 * Settings that run a program or spend money: only the user's own settings count. A
 * repository's .vscode/settings.json, which anyone can commit, could otherwise point
 * claudePath at a program of its own or raise the cost limits. (package.json also scopes
 * them to the machine or the application, so the Settings editor says so.)
 */
export const USER_ONLY: ReadonlySet<keyof Settings> = new Set<keyof Settings>([
  'agent',
  'claudePath',
  'codexPath',
  'model',
  'codexModel',
  'effort',
  'maxBudgetUsd',
  'summaryMaxBudgetUsd',
  'maxConcurrentQuestions',
]);

/** A setting's value now: read each time, so a change applies at once. */
export function setting<K extends keyof Settings>(name: K): Settings[K] {
  const config = vscode.workspace.getConfiguration('reviewDesk');
  if (USER_ONLY.has(name)) {
    const i = config.inspect<Settings[K]>(name);
    return (i?.globalValue ?? i?.defaultValue) as Settings[K];
  }
  return config.get(name) as Settings[K];
}

/**
 * Changes a setting where the change shows: in the workspace's settings when they have it
 * (they win over the user's), else in the user's.
 */
export async function setSetting<K extends keyof Settings>(
  name: K,
  value: Settings[K] | undefined,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('reviewDesk');
  const target =
    !USER_ONLY.has(name) && config.inspect(name)?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update(name, value, target);
}

/** The language explanations and answers are written in (English when left empty). */
export function language(): string {
  return languageName(setting('language')) ?? 'English';
}

/** The language PR comments are drafted in: reviewDesk.commentLanguage, else the notes' language. */
export function commentLanguage(): string {
  return languageName(setting('commentLanguage')) ?? language();
}
