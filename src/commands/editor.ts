import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Side } from '../review/diffParser';
import { SUMMARY } from '../agent/translate';
import { language, setSetting, setting } from '../settings';
import {
  AGENT_KINDS,
  agentLabel,
  agentName,
  agentTooltip,
  noticeDetail,
  notFound,
  signInCommand,
  type AgentKind,
  type AgentStatus,
} from '../shared/agentUse';
import { selectedLines } from '../ui/panelController';
import type { Command, Services } from './services';

/** A change in VS Code's inline change view (the `scm/change/title` menu passes these). */
interface LineChange {
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** Working tree lines of an inline change; a pure deletion (end 0) maps to the line after it. */
function changedLines(changes: LineChange[], index: number): [number, number] | undefined {
  const c = changes?.[index];
  if (!c) return undefined;
  if (c.modifiedEndLineNumber === 0) {
    const at = Math.max(1, c.modifiedStartLineNumber);
    return [at, at];
  }
  return [c.modifiedStartLineNumber, c.modifiedEndLineNumber];
}

const asUri = (u: vscode.Uri | string) => (typeof u === 'string' ? vscode.Uri.parse(u) : u);

/**
 * From the editor and the panel: explaining and asking about lines, summaries, moving between
 * cards, the diff ↔ file switch, and the language notes are written in.
 */
export function registerEditorCommands(command: Command, s: Services): void {
  const { controller, panel, handles } = s;
  command('reviewDesk.openPanel', () => panel.open(false));
  command('reviewDesk.explainSelection', () => {
    // Nothing selected inside a changed block: explain the whole block.
    const editor = vscode.window.activeTextEditor;
    const block =
      editor?.selection.isEmpty &&
      handles.blockAt(editor.document.uri, editor.selection.active.line + 1);
    return block
      ? panel.explainLines(editor.document.uri, block.start, block.end, block.side)
      : panel.explainSelection();
  });
  command('reviewDesk.askAboutSelection', () => panel.askAboutSelection());
  // A PR comment on the selected lines (nothing selected in a changed block: the block): the
  // box below the notes opens for it, where the reviewer says what it should say. Given what to
  // say (tests, the API), it is drafted at once.
  const draftComment = (
    uri: vscode.Uri,
    start: number,
    end: number,
    side?: Side,
    request?: string,
  ) =>
    request === undefined
      ? panel.composeComment(uri, start, end, side)
      : panel.draftCommentLines(uri, start, end, side, request);
  command('reviewDesk.draftComment', (request?: string) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(
        'Review Desk: select the lines to comment on in an editor.',
      );
      return undefined;
    }
    const block =
      editor.selection.isEmpty &&
      handles.blockAt(editor.document.uri, editor.selection.active.line + 1);
    const [start, end] = block ? [block.start, block.end] : selectedLines(editor.selection);
    return draftComment(
      editor.document.uri,
      start,
      end,
      block ? block.side : undefined,
      typeof request === 'string' ? request : undefined,
    );
  });
  // Change handles (CodeLens, hover links) pass the document URI as a string.
  command(
    'reviewDesk.draftCommentRange',
    (uri: vscode.Uri | string, start: number, end: number, side?: Side, request?: string) =>
      draftComment(asUri(uri), start, end, side, request),
  );
  // From the Summary of Changes row: 'show' (a click to look writes only a missing summary).
  command('reviewDesk.summarize', (mode?: unknown) =>
    panel.summarize(mode === 'show' ? 'show' : 'write'),
  );
  // From the editor or the Explorer: the file's URI; from the Review list: its file row;
  // from the command palette: nothing (the active editor's file).
  command('reviewDesk.summarizeFile', (arg?: vscode.Uri | string | { path: string }) => {
    const root = controller.target?.root;
    const uri =
      arg instanceof vscode.Uri
        ? arg
        : typeof arg === 'string'
          ? asUri(arg)
          : arg?.path && root
            ? vscode.Uri.file(path.join(root, arg.path))
            : vscode.window.activeTextEditor?.document.uri;
    if (uri) return panel.summarizeFile(uri);
    void vscode.window.showInformationMessage('Review Desk: open the file to summarize.');
    return undefined;
  });
  // Change handles (CodeLens, hover links) pass the document URI as a string.
  command(
    'reviewDesk.explainRange',
    (uri: vscode.Uri | string, start: number, end: number, side?: Side) =>
      panel.explainLines(asUri(uri), start, end, side),
  );
  command('reviewDesk.askAboutRange', (uri: vscode.Uri | string, start: number, end: number) =>
    panel.askAboutLines(asUri(uri), start, end),
  );
  command('reviewDesk.explainChange', (uri: vscode.Uri, changes: LineChange[], index: number) => {
    const lines = changedLines(changes, index);
    return lines && panel.explainLines(uri, lines[0], lines[1]);
  });
  command('reviewDesk.askAboutChange', (uri: vscode.Uri, changes: LineChange[], index: number) => {
    const lines = changedLines(changes, index);
    return lines && panel.askAboutLines(uri, lines[0], lines[1]);
  });

  // Diff ↔ file, in place by default (reviewDesk.diffOpensIn). From the title bar the commands
  // get the editor's URI only; CodeLens and hover links also pass the line.
  const showDiff = (uri?: vscode.Uri | string, line?: unknown) => {
    const editor = vscode.window.activeTextEditor;
    const target = uri ? asUri(uri) : editor?.document.uri;
    // The title bar passes a context object, not a line: use the cursor then.
    const at = typeof line === 'number' ? line : editor ? editor.selection.active.line + 1 : 1;
    return target && panel.showDiff(target, at);
  };
  command('reviewDesk.showDiff', showDiff);
  command('reviewDesk.compareAt', showDiff);
  // The title bar passes the diff's file; a hover link, its URI as a string.
  command('reviewDesk.showFile', (uri?: vscode.Uri | string) =>
    panel.showFile(uri ? asUri(uri) : undefined),
  );
  command('reviewDesk.backToFile', () => panel.showFile());
  command('reviewDesk.toggleDiff', () => panel.toggleDiff());
  // Inline (one column, - and + lines) or side-by-side diffs: VS Code's own diff setting,
  // so the review's multi-file diff follows it too.
  const diffLayout = (sideBySide: boolean) =>
    vscode.workspace
      .getConfiguration('diffEditor')
      .update('renderSideBySide', sideBySide, vscode.ConfigurationTarget.Global);
  command('reviewDesk.diffInline', () => diffLayout(false));
  command('reviewDesk.diffSideBySide', () => diffLayout(true));

  command('reviewDesk.nextCard', () => panel.move(1));
  command('reviewDesk.prevCard', () => panel.move(-1));
  command('reviewDesk.selectCard', (id: string) => {
    panel.open();
    return panel.select(id, true);
  });
  command('reviewDesk.openFile', (file: string, line?: number) => panel.openFile(file, line));

  // The agent that writes the notes: picked from the list of agents with how each stands.
  command('reviewDesk.chooseAgent', async () => {
    const { use, status } = s.agents;
    const current = setting('agent');
    const known = new Map<AgentKind, AgentStatus>();
    const load = async () => {
      const list = await Promise.all(AGENT_KINDS.map((kind) => status(kind)));
      for (const st of list) {
        known.set(st.kind, st);
        use.record(st.kind, st.source);
      }
      return list;
    };
    const picked = await s.prompts.pickAgent(current, load);
    if (!picked) return undefined;
    if (picked === 'about') {
      const info = use.info();
      void vscode.window.showInformationMessage(agentLabel(info), {
        modal: true,
        detail: `${agentTooltip(info)}\n\n${noticeDetail(info.agent, info.path)}`,
      });
      return undefined;
    }
    const st = known.get(picked) ?? (await status(picked));
    if (!st.path) {
      s.prompts.warn(`Review Desk: ${notFound(picked)}`);
      return undefined;
    }
    if (picked !== current) {
      await setSetting('agent', picked);
      vscode.window.setStatusBarMessage(
        `Review Desk: notes and answers by ${agentName(picked)}`,
        4000,
      );
    }
    if (st.signedIn === false) {
      const signIn = 'Sign In in a Terminal';
      const answer = await s.prompts.choose(
        `${agentName(picked)} is not signed in.`,
        [signIn],
        `Sign in with your ${picked === 'claude' ? 'Claude' : 'ChatGPT'} account or an API key: Review Desk runs ${agentName(picked)} with the account it is signed in to.`,
      );
      if (answer === signIn) {
        const terminal = vscode.window.createTerminal({ name: `${agentName(picked)} sign-in` });
        terminal.show();
        terminal.sendText(signInCommand(picked, st.path));
      }
    }
    return picked;
  });

  // The language of notes and answers: a short list, any other name, or the setting itself.
  command('reviewDesk.changeLanguage', async (name?: string) => {
    const picked = name ?? (await pickLanguage(language()));
    if (!picked) return undefined;
    await setSetting('language', picked);
    vscode.window.setStatusBarMessage(`Review Desk: notes and answers in ${picked}`, 4000);
    // Not awaited: the question waits for the reviewer, the language is changed already.
    void offerTranslation(s, picked);
    return picked;
  });
  // A note's text of Claude's into the current language (the panel's Translate button).
  command('reviewDesk.translateNotes', async (ids?: string[]) => {
    const lang = language();
    return panel.translator.translate(ids ?? panel.translator.candidates(lang), lang);
  });
}

const LANGUAGES = [
  'English',
  'Korean',
  'Japanese',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Spanish',
  'French',
  'German',
  'Portuguese',
  'Vietnamese',
  'Indonesian',
  'Russian',
];

/** A language for notes and answers; `undefined` when dismissed or sent to the settings. */
async function pickLanguage(current: string): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { language?: string; action?: 'other' | 'settings' };
  const items: Item[] = [
    ...LANGUAGES.map((l) => ({
      label: l,
      description: l.toLowerCase() === current.toLowerCase() ? 'current' : undefined,
      language: l,
    })),
    ...(LANGUAGES.some((l) => l.toLowerCase() === current.toLowerCase())
      ? []
      : [{ label: current, description: 'current', language: current }]),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(edit) Other Language…', action: 'other' },
    { label: '$(gear) Open Setting', description: 'reviewDesk.language', action: 'settings' },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Language of notes and answers',
    placeHolder: `Now: ${current}. New notes and answers use the language picked here.`,
  });
  if (!picked) return undefined;
  if (picked.action === 'settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'reviewDesk.language');
    return undefined;
  }
  if (picked.action === 'other') {
    const typed = await vscode.window.showInputBox({
      title: 'Language of notes and answers',
      prompt: 'Any language name, e.g. Thai, Polski, Español',
      value: current,
    });
    return typed?.trim() || undefined;
  }
  return picked.language;
}

/**
 * After a change of language, offers to translate the notes of the open review written in
 * another (Claude's text in them; the reviewer's questions stay), each in a claude run.
 */
async function offerTranslation(s: Services, to: string): Promise<void> {
  const ids = s.panel.translator.candidates(to);
  if (!ids.length) return;
  const n = ids.filter((id) => id !== SUMMARY).length;
  const notes = n === 1 ? 'the note' : n ? `${n} notes` : '';
  const what = [ids.includes(SUMMARY) && 'the summary', notes].filter(Boolean).join(' and ');
  const yes = 'Translate';
  const picked = await s.prompts.choose(
    `Translate ${what.startsWith('the') ? what : `the ${what}`} of this review into ${to}?`,
    [yes],
    `New notes and answers are written in ${to} from now on. What is already written can be translated too: Claude's text (not your questions; the summary's diagram and file lists stay as they are), each in a short claude run. It can also be translated later with the small Translate button on the summary or a note.`,
  );
  if (picked !== yes) return;
  const { failed } = await s.prompts.progress(`Translating ${what}…`, () =>
    s.panel.translator.translate(ids, to),
  );
  vscode.window.setStatusBarMessage(
    `Review Desk: translated into ${to}${failed ? ` (${failed} failed: see the summary or the notes)` : ''}`,
    6000,
  );
}
