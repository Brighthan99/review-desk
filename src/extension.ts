import * as os from 'node:os';
import * as vscode from 'vscode';
import { resolveClaudePath } from './agent/claudePath';
import { agentRunner } from './agent/agentRunner';
import { agentStatus } from './agent/agentStatus';
import { AgentUse } from './agent/agentUse';
import { CodexCliRunner } from './agent/codexRunner';
import { resolveCodexPath } from './agent/codexPath';
import { loggedRunner } from './agent/logged';
import { ClaudeCliRunner } from './agent/runner';
import { chatPlaces, chatRoot, registerChatCommands } from './commands/chat';
import { registerCompareCommands } from './commands/compare';
import { registerEditorCommands } from './commands/editor';
import { registerGitHubCommands } from './commands/github';
import { registerListCommands } from './commands/lists';
import { registerMenuCommands } from './commands/menu';
import type { Command, Services } from './commands/services';
import { ReviewController, type StartOptions } from './controller';
import { PullRequestService } from './github/prService';
import { setGitLog, setGitPath } from './review/git';
import { commentLanguage, language, setting } from './settings';
import { ChangeHandles } from './ui/changeHandles';
import { ChatConnection } from './ui/chatConnection';
import { FileBadges } from './ui/fileBadges';
import { resolveGitPath } from './ui/gitApi';
import { errorText, log, showError } from './ui/log';
import { PanelController } from './ui/panelController';
import { defaultPrompts, type Prompts } from './ui/prompts';
import { environmentLine, openProblemReport, type Environment } from './ui/report';
import { SavedReviewsTree } from './ui/reviewsTree';
import { DimmedRows } from './ui/comparisonRows';
import { ReviewTree } from './ui/tree';
import { BLOB_SCHEME, BlobDocuments } from './ui/viewedFiles';
import { WorktreesTree } from './ui/worktreesTree';

export interface ExtensionApi {
  controller: ReviewController;
  panel: PanelController;
  tree: ReviewTree;
  badges: FileBadges;
  handles: ChangeHandles;
  saved: SavedReviewsTree;
  github: PullRequestService;
  chat: ChatConnection;
  /** The questions, warnings and new windows of every service; tests answer them here. */
  prompts: Prompts;
  worktrees: WorktreesTree;
  /** The notice asked before the first Claude Code run, and the account the runs use. */
  /** The notice asked before an agent's first run, and the account its runs use. */
  agentUse: AgentUse;
}

/**
 * Makes the services and views, connects them, and registers the commands (one module per
 * area in src/commands).
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<ExtensionApi | undefined> {
  const gitPath = await resolveGitPath();
  setGitPath(gitPath);
  setGitLog((level, line) => log()[level](line));
  const claudePath = () =>
    resolveClaudePath({
      configured: setting('claudePath'),
      pathEnv: process.env.PATH ?? '',
      home: os.homedir(),
      bundledDir: vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath,
    });
  const codexPath = () =>
    resolveCodexPath({ configured: setting('codexPath'), pathEnv: process.env.PATH ?? '' });
  const agent = () => setting('agent');
  const env = (): Environment => ({
    version: String(context.extension.packageJSON.version),
    gitPath,
    claudePath: claudePath(),
  });
  // Where it runs, first in the log: what a problem report needs before anything else.
  void environmentLine(env()).then((line) => log().info(line));
  const controller = new ReviewController(context.globalStorageUri);
  // Tests answer its questions by replacing its methods (api.prompts).
  const prompts: Prompts = defaultPrompts();
  // Every run goes to the agent chosen (Claude Code or Codex), which asks once before its
  // first run whose agent and account it uses.
  const agentUse = new AgentUse(
    context.globalState,
    agent,
    (kind) => (kind === 'codex' ? codexPath() : claudePath()),
    (m, buttons, detail) => prompts.choose(m, buttons, detail),
  );
  const runner = agentUse.gate(
    loggedRunner(
      agentRunner(
        agent,
        { claude: new ClaudeCliRunner(claudePath), codex: new CodexCliRunner(codexPath) },
        () => setting('codexModel') || undefined,
      ),
      log(),
    ),
  );
  const panel = new PanelController(
    context.extensionUri,
    controller,
    runner,
    () => ({
      maxConcurrent: setting('maxConcurrentQuestions'),
      maxBudgetUsd: setting('maxBudgetUsd'),
      summaryMaxBudgetUsd: setting('summaryMaxBudgetUsd'),
      tools: 'Read,Grep,Glob',
      agent: setting('agent'),
      model: setting('model') || undefined,
      effort: setting('effort') || undefined,
      language: language(),
      commentLanguage: commentLanguage(),
      summaryDiagram: setting('summaryDiagram'),
      summaryReadingOrder: setting('summaryReadingOrder'),
    }),
    agentUse,
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('reviewDesk.agent') ||
        e.affectsConfiguration('reviewDesk.codexPath')
      )
        agentUse.changed();
    }),
  );
  const tree = new ReviewTree(controller);
  tree.summarizing = () => panel.explain.isSummarizing;
  let summarizing = false;
  const github = new PullRequestService(controller, prompts);
  controller.prBase = (root, branch) => github.openPullBase(root, branch);
  // Looked up at each call: tests replace api.prompts.progress.
  controller.progress = (title, task) => prompts.progress(title, task);
  const badges = new FileBadges(controller);
  const handles = new ChangeHandles(controller);
  const saved = new SavedReviewsTree(controller, prompts);
  const worktrees = new WorktreesTree(controller, prompts);
  const worktreesView = vscode.window.createTreeView('reviewDesk.worktrees', {
    treeDataProvider: worktrees,
  });
  const chat = new ChatConnection(
    context.extensionPath,
    context.globalStorageUri.fsPath,
    claudePath,
    gitPath,
  );
  try {
    chat.installScript();
  } catch {
    // Not connected anywhere yet, or the copy failed: connecting copies it again.
  }
  // Its file rows have Viewed checkboxes, each its own (a folder has none).
  const filesView = vscode.window.createTreeView('reviewDesk.files', {
    treeDataProvider: tree,
    // Its own Collapse All and Expand All are in the menu: the title keeps two buttons.
    manageCheckboxStateManually: true,
  });
  tree.view = filesView;
  context.subscriptions.push(
    log(),
    controller,
    panel,
    tree,
    badges,
    handles,
    saved,
    filesView,
    filesView.onDidChangeCheckboxState((e) => tree.checked(e.items)),
    vscode.window.registerFileDecorationProvider(new DimmedRows()),
    // The buttons on a review preview (an untitled markdown document) before posting it.
    vscode.languages.registerCodeLensProvider({ scheme: 'untitled' }, github.previewLenses),
    // New replies on the pull request reviewed: looked for now and then (githubCheckMinutes).
    github.watchReplies(),
    github.onDidCheck((c) => panel.setGithubCheck(c)),
    vscode.workspace.registerTextDocumentContentProvider(
      BLOB_SCHEME,
      new BlobDocuments(controller),
    ),
    vscode.window.createTreeView('reviewDesk.reviews', { treeDataProvider: saved }),
    worktrees,
    worktreesView,
    // Worktrees come and go outside the extension too: look again when the list is shown, and
    // on coming back to this window (a worktree folder deleted by hand, a branch switched in
    // another window: nothing the list watches tells of those).
    worktreesView.onDidChangeVisibility((e) => e.visible && worktrees.refresh()),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused && worktreesView.visible) worktrees.refresh();
    }),
    // The summary row says when one is being written (not on every streamed chunk).
    panel.host.onDidPost(() => {
      if (summarizing === panel.explain.isSummarizing) return;
      summarizing = !summarizing;
      tree.refresh();
    }),
    controller.onDidChange(() =>
      vscode.commands.executeCommand(
        'setContext',
        'reviewDesk.active',
        controller.target !== undefined,
      ),
    ),
  );

  // Every command logged (at the Debug level) and its failures too, with what caused them.
  const titles = new Map<string, string>(
    (context.extension.packageJSON.contributes?.commands ?? []).map(
      (c: { command: string; title: string }) => [c.command, c.title.replace(/…$/, '')],
    ),
  );
  const command: Command = (id, fn) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        log().debug(`command ${id}`);
        try {
          return await fn(...args);
        } catch (e) {
          showError(`Review Desk: ${titles.get(id) ?? id} failed. ${errorText(e)}`, e);
          return undefined;
        }
      }),
    );
  command('reviewDesk.showLog', () => log().show());
  command('reviewDesk.reportProblem', () => openProblemReport(controller, env(), context));
  const start = async (options?: StartOptions) => {
    const ok = await controller.start(options);
    if (ok && setting('openPanelOnStart')) panel.open();
    return ok;
  };
  const services: Services = {
    controller,
    panel,
    tree,
    handles,
    saved,
    github,
    chat,
    prompts,
    worktrees,
    agents: {
      use: agentUse,
      status: (kind) => agentStatus(kind, kind === 'codex' ? codexPath() : claudePath()),
    },
    start,
  };
  registerListCommands(command, services);
  registerCompareCommands(command, services);
  registerEditorCommands(command, services);
  registerGitHubCommands(command, services);
  registerChatCommands(command, services);
  registerMenuCommands(command, services);

  // A worktree added to this window as a folder: the review left for it starts. (A window of
  // one folder restarts its extensions instead, and the start below finds it.)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      if (e.added.length) void github.resumePending(e.added.map((f) => f.uri.fsPath));
    }),
  );
  // The review this window had, or one another window left for it (a checkout into a new
  // worktree); and the chat connection kept pointing at the current Review Desk.
  void controller
    .restore()
    .then(() => github.resumePending())
    .then(() => chatRoot(controller))
    .then(async (root) => (root ? chat.keepCurrent(root, await chatPlaces(root)) : undefined))
    .catch(() => undefined);

  // The services go to the tests only: any other extension can read an extension's exports,
  // and could accept the Claude Code notice or answer the confirmations (posting to GitHub)
  // through them.
  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    controller,
    panel,
    tree,
    badges,
    handles,
    saved,
    github,
    chat,
    prompts,
    worktrees,
    agentUse,
  };
}

export function deactivate(): void {}
