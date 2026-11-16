import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { realpath } from '../review/realpath';
import { log } from './log';

/** Where Review Desk runs, for the log's first line and a problem report. */
export interface Environment {
  version: string;
  gitPath: string;
  claudePath: string;
}

/** A program's `--version`, or why it could not be run. */
function versionOf(program: string): Promise<string> {
  if (!program) return Promise.resolve('not found');
  return new Promise((resolve) => {
    execFile(program, ['--version'], { timeout: 5000 }, (error, stdout) =>
      resolve(error ? `not runnable: ${error.message.split('\n')[0]}` : stdout.trim()),
    );
  });
}

/** One line on where Review Desk runs: its version, VS Code, the OS, git, claude, folders. */
export async function environmentLine(env: Environment): Promise<string> {
  const [git, claude] = await Promise.all([versionOf(env.gitPath), versionOf(env.claudePath)]);
  const folders = vscode.workspace.workspaceFolders?.length ?? 0;
  return [
    `Review Desk ${env.version}`,
    `${vscode.env.appName} ${vscode.version}${vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : ''}`,
    `${process.platform} ${os.release()} ${process.arch}`,
    `git ${env.gitPath} (${git})`,
    `claude ${env.claudePath} (${claude})`,
    `${folders} ${folders === 1 ? 'folder' : 'folders'} open`,
  ].join(' · ');
}

const LEVELS = ['Off', 'Trace', 'Debug', 'Info', 'Warning', 'Error'];

/** The settings set away from their defaults (user or workspace), as `key: value` lines. */
function changedSettings(packageJson: { contributes?: { configuration?: unknown } }): string[] {
  const properties =
    (packageJson.contributes?.configuration as { properties?: Record<string, unknown> })
      ?.properties ?? {};
  const config = vscode.workspace.getConfiguration();
  return Object.keys(properties).flatMap((key) => {
    const i = config.inspect(key);
    const set = [
      i?.globalValue !== undefined && `user ${JSON.stringify(i.globalValue)}`,
      i?.workspaceValue !== undefined && `workspace ${JSON.stringify(i.workspaceValue)}`,
      i?.workspaceFolderValue !== undefined && `folder ${JSON.stringify(i.workspaceFolderValue)}`,
    ].filter(Boolean);
    return set.length ? [`${key}: ${set.join(', ')}`] : [];
  });
}

/** The last `lines` lines of the log file. */
function logTail(logFile: string, lines: number): string {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').slice(-lines).join('\n').trim();
  } catch {
    return `(no log file at ${logFile})`;
  }
}

/**
 * Opens a problem report in an editor: what happened (for the reviewer to write), where
 * Review Desk runs, the window's folders, the review, settings changed and the end of the
 * log. Nothing is sent anywhere: the reviewer reads it, removes what they don't want to
 * share (paths, branch names) and sends it.
 */
export async function openProblemReport(
  controller: ReviewController,
  env: Environment,
  context: vscode.ExtensionContext,
): Promise<void> {
  const repos = await controller.folders.load();
  const start = controller.folders.selected();
  const t = controller.target;
  const review = controller.review;
  const folders = repos.length
    ? repos.map((r) => {
        const marks = [
          !r.sha && 'no commits yet',
          t && r.root === realpath(t.root) ? 'reviewing' : r === start && 'a review starts here',
        ].filter(Boolean);
        return `- ${path.basename(r.root)}: ${r.branch}${r.sha ? ` (${r.sha.slice(0, 7)})` : ''}${marks.length ? ` — ${marks.join(', ')}` : ''}`;
      })
    : ['- no git repository'];
  const reviewLines = t
    ? [
        `- ${path.basename(t.root)}: ${t.head.ref} (${t.head.sha.slice(0, 7)}) against ${t.base.ref} (${t.base.sha.slice(0, 7)})`,
        `- ${t.workTree ? 'working tree (uncommitted changes included)' : 'HEAD only'}, ${t.files.length} changed files, ${review?.annotations.length ?? 0} notes${review?.github ? `, PR #${review.github.number}` : ''}`,
        ...(controller.loadError
          ? [`- review file error: ${controller.loadError.split('\n')[0]}`]
          : []),
      ]
    : ['- no review open'];
  const settings = changedSettings(context.extension.packageJSON);
  const logFile = path.join(context.logUri.fsPath, 'Review Desk.log');
  const text = [
    '# Review Desk problem report',
    '',
    '> Nothing has been sent. Read it through and remove what you would rather not share',
    '> (file paths, branch names, log lines), then send it to the Review Desk developer.',
    '',
    '## What happened',
    '',
    '(What you did, what you expected, and what happened instead.)',
    '',
    '## Where it runs',
    '',
    `- ${(await environmentLine(env)).split(' · ').join('\n- ')}`,
    `- log level ${LEVELS[log().logLevel] ?? log().logLevel}${log().logLevel > vscode.LogLevel.Debug ? ' (for more detail: Output → Review Desk → ⚙ → Debug, then do it again and report again)' : ''}`,
    '',
    '## Folders',
    '',
    ...folders,
    '',
    '## Review',
    '',
    ...reviewLines,
    '',
    '## Settings changed',
    '',
    ...(settings.length ? settings.map((s) => `- ${s}`) : ['- none']),
    '',
    '## Log (the last 300 lines)',
    '',
    '```',
    logTail(logFile, 300),
    '```',
    '',
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
  await vscode.window.showTextDocument(doc);
}
