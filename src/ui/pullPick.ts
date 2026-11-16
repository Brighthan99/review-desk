import * as vscode from 'vscode';
import { GitHubClient, type PullRequest } from '../github/client';
import { parsePullUrl } from '../github/prUrl';
import { errorText } from './log';

/** What the pull request list shows: the open ones, an offer to sign in, or why there are none. */
export type PullListing =
  { pulls: PullRequest[]; repo: string } | { signIn: true } | { note: string };

/** A pull request picked to review: an open one listed, or any one by its address. */
export type PullPick = { pr: PullRequest } | { url: string };

/**
 * Asks which pull request to review: one of the open pull requests of the repository here,
 * listed as soon as GitHub answers (`load`, asked to sign in only when the reviewer picks
 * that), or any pull request by its address, typed or pasted in; one on the clipboard is
 * offered first.
 */
export async function askPull(
  load: (signIn: boolean) => Promise<PullListing>,
): Promise<PullPick | undefined> {
  type Item = vscode.QuickPickItem & { pick?: PullPick; signIn?: boolean };
  const clip = (await vscode.env.clipboard.readText()).trim();
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = 'Review a Pull Request';
  qp.placeholder =
    'Pick an open pull request, or paste the address of any (https://github.com/owner/repo/pull/123)';
  qp.matchOnDescription = true;
  const byAddress = (url: string, label: string): Item => {
    const ref = parsePullUrl(url)!;
    return {
      label: `$(link) ${label} #${ref.number}`,
      description: `${ref.owner}/${ref.repo}`,
      detail: 'Its base as the base, its head as the compare side.',
      alwaysShow: true,
      pick: { url },
    };
  };
  let listed: Item[] = [];
  const render = () => {
    const typed = qp.value.trim();
    const address = parsePullUrl(typed)
      ? [byAddress(typed, 'Review Pull Request')]
      : !typed && parsePullUrl(clip)
        ? [byAddress(clip, 'From the clipboard: Pull Request')]
        : [];
    qp.items = [...address, ...listed];
  };
  const fill = async (signIn: boolean) => {
    qp.busy = true;
    // Signing in shows a dialog: the list stays open behind it.
    qp.ignoreFocusOut = signIn;
    const listing = await load(signIn).catch((e: unknown): PullListing => ({
      note: `Could not list the open pull requests. ${errorText(e)}`,
    }));
    qp.busy = false;
    qp.ignoreFocusOut = false;
    listed =
      'pulls' in listing
        ? listing.pulls.length
          ? [
              { label: `Open in ${listing.repo}`, kind: vscode.QuickPickItemKind.Separator },
              ...listing.pulls.map((pr) => ({
                label: `#${pr.number} ${pr.title}`,
                // The base first, as the review shows it.
                description: `${pr.base.ref} ↔ ${pr.head.ref}`,
                detail: `${pr.user?.login ?? ''}${pr.draft ? ' · draft' : ''}`,
                pick: { pr },
              })),
              // Only the newest are listed: say so, the others are a paste away.
              ...(listing.pulls.length >= GitHubClient.PULLS_LISTED
                ? [
                    {
                      label: `$(info) The ${listing.pulls.length} newest are listed: paste the address of another to open it`,
                      alwaysShow: true,
                    },
                  ]
                : []),
            ]
          : [{ label: `$(info) No open pull requests in ${listing.repo}`, alwaysShow: true }]
        : 'signIn' in listing
          ? [
              {
                label: '$(account) Sign in to GitHub to List the Open Pull Requests',
                alwaysShow: true,
                signIn: true,
              },
            ]
          : [{ label: `$(info) ${listing.note}`, alwaysShow: true }];
    render();
  };
  return new Promise<PullPick | undefined>((resolve) => {
    qp.onDidChangeValue(render);
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      if (item?.signIn) {
        void fill(true);
        return;
      }
      const typed = qp.value.trim();
      const pick = item?.pick ?? (parsePullUrl(typed) ? { url: typed } : undefined);
      // A line that says why nothing is listed: nothing to open.
      if (!pick) return;
      resolve(pick);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    render();
    qp.show();
    void fill(false);
  });
}
