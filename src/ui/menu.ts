import * as vscode from 'vscode';

/** What the menu depends on: whether a review is open, how the list shows it, the chat. */
export interface MenuState {
  active: boolean;
  mode: 'folder' | 'order' | 'reading';
  hasReadingOrder: boolean;
  showAll: boolean;
  hideViewed: boolean;
  chatConnected: boolean;
  /** The window has more than one folder: a review can start in another. */
  severalFolders: boolean;
  language: string;
  /** Why the review file could not be read, if it could not. */
  loadError?: string;
}

/** A row of the menu: a command to run, or a heading. */
export interface MenuItem extends vscode.QuickPickItem {
  command?: string;
}

const heading = (label: string): MenuItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
const NOW = '✓ now';

/**
 * Everything Review Desk does from its list, in one searchable menu: the Review list's ☰
 * button and the status bar item open it. The list's title keeps only Compare and this menu,
 * so a narrow side bar still shows both.
 */
export function menuItems(s: MenuState): MenuItem[] {
  const items: MenuItem[] = [];
  if (s.loadError) {
    items.push({
      label: '$(warning) Show Review File Error',
      description: s.loadError.split('\n')[0],
      command: 'reviewDesk.openReviewFile',
    });
  }
  if (!s.active) {
    items.push(
      heading('Start'),
      {
        label: '$(play) Start Review',
        description: 'This branch against its base',
        command: 'reviewDesk.start',
      },
      {
        label: '$(git-compare) Start Review Against Branch…',
        description: 'Pick the base first',
        command: 'reviewDesk.startWithBase',
      },
      ...(s.severalFolders
        ? [{ label: '$(folder) Start Review in Folder…', command: 'reviewDesk.startInFolder' }]
        : []),
    );
  } else {
    items.push(
      heading('Show in the list'),
      {
        label: '$(list-tree) Folders',
        description: s.mode === 'folder' ? NOW : 'Changed files by folder',
        command: 'reviewDesk.tree.showFolders',
      },
      {
        label: '$(list-ordered) Notes in Order',
        description: s.mode === 'order' ? NOW : 'The notes, grouped',
        command: 'reviewDesk.tree.showOrder',
      },
      ...(s.hasReadingOrder
        ? [
            {
              label: '$(milestone) Reading Order',
              description: s.mode === 'reading' ? NOW : 'The order the summary suggests',
              command: 'reviewDesk.tree.showReading',
            },
          ]
        : []),
      ...(s.mode === 'folder'
        ? [
            s.showAll
              ? {
                  label: '$(diff) Show Changed Files Only',
                  description: 'All files shown now',
                  command: 'reviewDesk.tree.showChanged',
                }
              : {
                  label: '$(files) Show All Files',
                  description: 'Unchanged ones too',
                  command: 'reviewDesk.tree.showAll',
                },
          ]
        : []),
      ...(s.mode !== 'order'
        ? [
            s.hideViewed
              ? {
                  label: '$(eye) Show Viewed Files',
                  description: 'Viewed files hidden now',
                  command: 'reviewDesk.showViewed',
                }
              : {
                  label: '$(eye-closed) Hide Viewed Files',
                  description: 'Files changed since viewed come back',
                  command: 'reviewDesk.hideViewed',
                },
          ]
        : []),
      { label: '$(expand-all) Expand All', command: 'reviewDesk.tree.expandAll' },
      { label: '$(collapse-all) Collapse All', command: 'reviewDesk.tree.collapseAll' },

      heading('Review'),
      { label: '$(review-desk-logo) Open Notes Panel', command: 'reviewDesk.openPanel' },
      {
        label: '$(review-desk-logo) Summarize Changes',
        description: 'What changed across the review',
        command: 'reviewDesk.summarize',
      },
      {
        label: '$(review-desk-logo) Summarize File',
        description: 'The file in the editor',
        command: 'reviewDesk.summarizeFile',
      },
      {
        label: '$(review-desk-logo) Explain Code',
        description: 'Lines selected in the editor',
        command: 'reviewDesk.explainSelection',
      },
      {
        label: '$(comment) Draft PR Comment…',
        description: 'On the lines selected, for the pull request',
        command: 'reviewDesk.draftComment',
      },
      {
        label: '$(git-compare) Compare…',
        description: 'Change the base or the compare side',
        command: 'reviewDesk.compare',
      },
      { label: '$(refresh) Restart Review', command: 'reviewDesk.start' },
      {
        label: '$(pass) Finish Review…',
        description: 'Back to main, the review closed',
        command: 'reviewDesk.finishReview',
      },
      { label: '$(close) Close Review', command: 'reviewDesk.closeReview' },
      { label: '$(json) Open Review File', command: 'reviewDesk.openReviewFile' },
    );
  }
  items.push(
    heading('GitHub'),
    {
      label: '$(cloud-download) Fetch',
      description: 'Get where the branches are on the remote now',
      command: 'reviewDesk.fetch',
    },
    // One list for both: the open pull requests, and any one by its address pasted in.
    {
      label: '$(github) Open GitHub Pull Request',
      description: 'An open one, or any by its address',
      command: 'reviewDesk.github.open',
    },
    ...(s.active
      ? [
          { label: '$(cloud-upload) Post Notes as PR Review', command: 'reviewDesk.github.post' },
          {
            label: '$(comment-discussion) Re-import GitHub Comments',
            command: 'reviewDesk.github.importThreads',
          },
        ]
      : []),

    heading('Claude'),
    s.chatConnected
      ? {
          label: '$(debug-disconnect) Disconnect Claude Code Chat',
          description: 'Stop letting the chat read the notes',
          command: 'reviewDesk.disconnectChat',
        }
      : {
          label: '$(comment-discussion) Connect Claude Code Chat',
          description: 'Let the Claude Code chat read the notes',
          command: 'reviewDesk.connectChat',
        },
    {
      label: '$(hubot) Choose Agent…',
      description: 'Claude Code or Codex, and its account',
      command: 'reviewDesk.chooseAgent',
    },
    {
      label: '$(globe) Change Answer Language…',
      description: `now ${s.language}`,
      command: 'reviewDesk.changeLanguage',
    },
    ...(s.active
      ? [
          {
            label: '$(globe) Translate Notes into the Current Language',
            description: `the summary and notes not in ${s.language}`,
            command: 'reviewDesk.translateNotes',
          },
        ]
      : []),

    heading('Help'),
    { label: '$(output) Show Log', command: 'reviewDesk.showLog' },
    {
      label: '$(report) Report a Problem…',
      description: 'A report to send, nothing sent by itself',
      command: 'reviewDesk.reportProblem',
    },
  );
  return items;
}

/** Shows the menu; the item picked, if any. */
export async function askMenu(items: MenuItem[]): Promise<MenuItem | undefined> {
  return vscode.window.showQuickPick(items, {
    title: 'Review Desk',
    placeHolder: 'Type to find what to do',
    matchOnDescription: true,
  });
}
