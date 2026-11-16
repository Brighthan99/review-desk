import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { Prompts } from '../../src/ui/prompts';

export const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

export const run = (...args: string[]) =>
  execFileSync('git', args, { cwd: workspace(), encoding: 'utf8' }).trim();

export async function until(what: string, check: () => boolean, timeout = 10000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The extension, with the notice asked before the first Claude Code run accepted: a test of
 * the notice resets it (api.agentUse.reset()).
 */
export async function activate(): Promise<ExtensionApi> {
  const api = await vscode.extensions
    .getExtension<ExtensionApi>('brighthan99.review-desk')!
    .activate();
  // Its services are exported in test mode only (src/extension.ts).
  if (!api) throw new Error('Review Desk exports its services to tests only: not run as a test?');
  if (!api.agentUse.accepted('claude')) await api.agentUse.accept('claude');
  if (!api.agentUse.accepted('codex')) await api.agentUse.accept('codex');
  return api;
}

/**
 * Gives a suite its own branch and head commit on top of the fixture's feat/refresh state,
 * so reviews stored by one suite never leak into another. Returns the new head.
 */
/**
 * Answers for the reviewer: replaces some of the prompts (questions, warnings, new windows)
 * until the returned function puts the earlier ones back.
 */
export function answering(api: ExtensionApi, answers: Partial<Prompts>): () => void {
  const earlier = { ...api.prompts };
  Object.assign(api.prompts, answers);
  return () => Object.assign(api.prompts, earlier);
}

/**
 * A top row of the Review list by its id ('where', 'base', 'finish', 'summary'); a row that
 * folds has `#n` after it once Expand All was used.
 */
export async function topRow(api: ExtensionApi, id: string) {
  const nodes = await api.tree.getChildren();
  return nodes.find((n) => api.tree.getTreeItem(n).id?.replace(/#\d+$/, '') === id);
}

export async function freshBranch(api: ExtensionApi, name: string): Promise<string> {
  run('switch', '-q', '-C', name, 'fixture-refresh');
  run('commit', '-q', '--allow-empty', '-m', `suite ${name}`);
  const head = run('rev-parse', 'HEAD');
  // An open review follows HEAD on its own, but its base may be gone (a suite's remote), so
  // re-target it explicitly against main.
  if (api.controller.target) {
    await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false });
    await until('review on the new head', () => api.controller.target?.head.sha === head);
  }
  return head;
}

export interface FakeCall {
  args: string[];
  prompt: string;
}

/** Calls the fake claude received, oldest first (from $FAKE_CLAUDE_LOG). */
export function fakeCalls(): FakeCall[] {
  const log = process.env.FAKE_CLAUDE_LOG!;
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeCall);
}

export const argAfter = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Points the extension at the fake claude in test/fixtures. */
export async function useFakeClaude(on: boolean): Promise<void> {
  const ext = vscode.extensions.getExtension<ExtensionApi>('brighthan99.review-desk')!;
  await vscode.workspace
    .getConfiguration('reviewDesk')
    .update(
      'claudePath',
      on ? path.join(ext.extensionPath, 'test', 'fixtures', 'fake-claude.mjs') : undefined,
      vscode.ConfigurationTarget.Global,
    );
}
