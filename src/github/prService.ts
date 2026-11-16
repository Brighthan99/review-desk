import * as path from 'node:path';
import * as vscode from 'vscode';
import { UNCHANGED, type ReviewController } from '../controller';
import type { BaseChoice } from '../review/branchBase';
import { gitOrNull } from '../review/git';
import type { GitHubInfo } from '../review/model';
import type { GithubCheck } from '../shared/protocol';
import { readSide } from '../review/target';
import {
  fetchPullRequest,
  ghprBranchPr,
  githubRemote,
  keepName,
  movePullBranch,
  prBranch,
  remoteFor,
} from './checkout';
import { authProviderFor, isGitHubHost } from './hosts';
import { parsePullUrl, type PullRef } from './prUrl';
import { repoRoot } from '../review/target';
import { GitHubClient, type PullRequest, type ReviewComment } from './client';
import { applyThreads, type ReviewEvent } from './convert';
import { postNotes, type PostOptions, type PreviewAnswer } from './posting';
import { ReviewPreviews } from './previews';
import type { RemoteRepo } from './remote';
import { clearPending, readPending } from '../review/pending';
import { samePath } from '../review/realpath';
import { checkOut, type Place } from '../ui/place';
import type { Prompts } from '../ui/prompts';
import { errorText, log, showError } from '../ui/log';
import { setting } from '../settings';
import { applyResolved, newReplies, threadRootId } from './replies';

interface Connection {
  client: GitHubClient;
  remote: string;
  repo: RemoteRepo;
}

/** Test seam: replaces the GitHub connection and the review preview. */
export interface PrServiceHooks {
  connect?: (root: string) => Promise<Connection | undefined>;
  /**
   * Instead of the preview in an editor: whether to post, how (default COMMENT), and the
   * preview as edited (default as it was).
   */
  preview?: (summary: string, preview: string) => Promise<PreviewAnswer>;
}

type Remote = { name: string; repo: RemoteRepo };

/** Opening a GitHub PR for review, importing its review threads and posting AI notes back. */
/** Where a review is: its repository's git dir and its head, to change it later (mutateAt). */
const pin = (target: { gitDir: string; head: { sha: string } }) => ({
  gitDir: target.gitDir,
  headSha: target.head.sha,
});

export class PullRequestService {
  hooks: PrServiceHooks = {};
  /** Reviews shown in an editor before posting. */
  readonly previews = new ReviewPreviews();
  /** The ETag of each pull request's review comments as last read: unchanged ones cost nothing. */
  private readonly etags = new Map<string, string>();
  /** Pull requests whose threads were read since the extension started. */
  private readonly imported = new Set<string>();
  private checkedAt = 0;
  private checking = false;
  /** New replies already said, so only more of them are said again. */
  private told = 0;
  private readonly checks = new vscode.EventEmitter<GithubCheck>();
  /** GitHub being read for the review's pull request, or done (when), or failed (why). */
  readonly onDidCheck = this.checks.event;

  constructor(
    private readonly controller: ReviewController,
    private readonly prompts: Prompts,
  ) {}

  /**
   * Asks GitHub how the review's pull request stands (open, merged, closed; and into which
   * branch), keeping it with the review. Never asks to sign in. Says what changed, if anything.
   */
  async checkState(): Promise<string | undefined> {
    const { target, review } = this.controller;
    const gh = review?.github;
    if (!target || !gh) return undefined;
    const conn = await this.connect(target.root, true, await this.remoteOf(target.root, gh)).catch(
      () => undefined,
    );
    const pr = conn && (await conn.client.getPull(gh.number).catch(() => undefined));
    if (!pr) return undefined;
    const state = pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
    if (state === gh.state && pr.base.ref === gh.baseRef) return undefined;
    this.controller.mutateAt(pin(target), (r) => {
      if (r.github?.number !== gh.number) return;
      r.github.state = state;
      r.github.baseRef = pr.base.ref;
    });
    return state === 'open'
      ? `PR #${gh.number} is open, into ${pr.base.ref}.`
      : `PR #${gh.number} was ${state}${state === 'merged' ? ` into ${pr.base.ref}` : ''}.`;
  }

  /** The buttons at the top of a review preview: how to post it, or not at all. */
  get previewLenses(): vscode.CodeLensProvider {
    return this.previews.lenses;
  }

  /** Answers a preview's buttons. */
  postAs(uri: string, event: ReviewEvent | undefined): void {
    this.previews.answer(uri, event);
  }

  private root(): string | undefined {
    return this.controller.target?.root ?? this.controller.workspaceCwd();
  }

  /**
   * With `silent`, no messages and no sign-in prompt: undefined unless already signed in.
   * `to` is the remote to use, else the one that points at GitHub (origin first).
   */
  /**
   * The remote of the pull request's own repository, as it was opened: a PR opened from a
   * fork's upstream is the upstream's, not origin's (the fork). When no remote points at it
   * (any more), its repository itself: the API needs no remote.
   */
  private async remoteOf(root: string, gh: GitHubInfo): Promise<Remote> {
    const repo = { host: gh.host, owner: gh.owner, repo: gh.repo };
    return (await remoteFor(root, repo).catch(() => undefined)) ?? { name: '', repo };
  }

  private async connect(
    root: string,
    silent = false,
    to?: Remote,
  ): Promise<Connection | undefined> {
    if (this.hooks.connect) {
      const conn = await this.hooks.connect(root);
      return conn && to ? { ...conn, remote: to.name } : conn;
    }
    const remote = to ?? (await githubRemote(root, isGitHubHost));
    if (!remote) {
      if (!silent) {
        showError('Review Desk: no git remote points to a GitHub repository.');
      }
      return undefined;
    }
    const provider = authProviderFor(remote.repo.host);
    if (!provider) {
      if (!silent) {
        showError(
          `Review Desk: ${remote.repo.host} is not GitHub. For a GitHub Enterprise Server, set github-enterprise.uri in your user settings to it and sign in.`,
        );
      }
      return undefined;
    }
    if (silent) {
      const session = await vscode.authentication.getSession(provider, ['repo'], { silent: true });
      if (!session) return undefined;
      const client = new GitHubClient(remote.repo, async () => session.accessToken);
      return { client, remote: remote.name, repo: remote.repo };
    }
    const token = async () =>
      (await vscode.authentication.getSession(provider, ['repo'], { createIfNone: true }))
        .accessToken;
    return { client: new GitHubClient(remote.repo, token), remote: remote.name, repo: remote.repo };
  }

  /**
   * The target branch of the open PR for `branch`, as a ref to compare with. Never asks to
   * sign in and gives up after a few seconds, since it runs whenever a review starts.
   */
  async openPullBase(root: string, branch: string): Promise<BaseChoice | undefined> {
    const lookup = async (): Promise<BaseChoice | undefined> => {
      const conn = await this.connect(root, true);
      const pr = conn && (await conn.client.findOpenPull(branch));
      if (!conn || !pr) return undefined;
      const tracking = `${conn.remote}/${pr.base.ref}`;
      const exists = await gitOrNull(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${tracking}^{commit}`,
      ]);
      return { ref: exists ? tracking : pr.base.ref, source: 'pr', detail: `#${pr.number}` };
    };
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 4000));
    return Promise.race([lookup().catch(() => undefined), timeout]);
  }

  /**
   * Lets the reviewer pick a pull request, an open one of the repository here or any one by
   * its address, and how to check it out, then starts the review. Returns the folder the
   * review goes on in.
   */
  async open(): Promise<string | undefined> {
    const root = this.root();
    let conn: Connection | undefined;
    const picked = await this.prompts.pickPull(async (signIn) => {
      if (!root) return { note: 'Open a git repository to list its pull requests.' };
      if (!this.hooks.connect && !(await githubRemote(root, isGitHubHost))) {
        return { note: 'No remote of this repository is on GitHub: paste the address of one.' };
      }
      conn = await this.connect(root, !signIn);
      if (!conn) return { signIn: true };
      const { owner, repo } = conn.repo;
      return { pulls: await conn.client.listPulls(), repo: `${owner}/${repo}` };
    });
    if (!picked) return undefined;
    if ('url' in picked) return this.openUrl(picked.url);
    const mode = await this.pickMode(root!, picked.pr);
    if (!mode) return undefined;
    return this.checkout(conn!, picked.pr, mode);
  }

  /** Where to check a pull request out: its branch here, or a worktree in a new window. */
  private pickMode(root: string, pr: PullRequest): Promise<Place | undefined> {
    return this.prompts.pickPlace({
      root,
      ref: prBranch(pr),
      branch: prBranch(pr),
      title: `#${pr.number} ${pr.title}`,
      placeHolder: `Where to check it out? It is compared with ${pr.base.ref}, where it branched off.`,
      hereFirst: true,
    });
  }

  /**
   * Opens a pull request from its address (or `owner/repo#n`); without one, the list to pick
   * from (see `open`). The repository open here that has it as a remote fetches it,
   * then it is reviewed like any picked pull request: its base as the base, its head as the
   * compare side, here or in a worktree for a new window.
   */
  async openUrl(address?: string): Promise<string | undefined> {
    if (!address) return this.open();
    const ref = parsePullUrl(address);
    if (!ref) {
      showError(
        `Review Desk: "${address}" is not the address of a pull request (https://github.com/owner/repo/pull/123).`,
      );
      return undefined;
    }
    const place = await this.repositoryOf(ref);
    if (!place) {
      showError(
        `Review Desk: no folder open here has ${ref.host}/${ref.owner}/${ref.repo} as a git remote. Open a clone of it, then the pull request again.`,
      );
      return undefined;
    }
    const conn = await this.connect(place.root, false, place.remote);
    if (!conn) return undefined;
    let pr: PullRequest;
    try {
      pr = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Fetching pull request #${ref.number}…`,
        },
        () => conn.client.getPull(ref.number),
      );
    } catch (e) {
      showError(
        `Review Desk: could not get pull request #${ref.number} of ${ref.owner}/${ref.repo}. ${errorText(e)}`,
        e,
      );
      return undefined;
    }
    const mode = await this.pickMode(place.root, pr);
    if (!mode) return undefined;
    return this.checkout(conn, pr, mode, place.root);
  }

  /** The repository open here (the review's first) with a remote pointing at the PR's. */
  private async repositoryOf(ref: PullRef): Promise<{ root: string; remote: Remote } | undefined> {
    const folders = [
      this.controller.target?.root,
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    ].filter((f): f is string => !!f);
    const seen = new Set<string>();
    for (const folder of folders) {
      const root = await repoRoot(folder).catch(() => undefined);
      if (!root || seen.has(root)) continue;
      seen.add(root);
      const remote = await remoteFor(root, ref);
      if (remote) return { root, remote };
    }
    return undefined;
  }

  /**
   * Fetches a pull request and checks it out for its review, here or in a worktree for a
   * new window (see `checkOut`). Returns the folder the review goes on in.
   */
  async checkout(
    conn: Connection,
    pr: PullRequest,
    mode: Place,
    root = this.root()!,
  ): Promise<string | undefined> {
    const { base, update } = await this.prompts.progress(
      `Fetching pull request #${pr.number}…`,
      () => fetchPullRequest(root, conn.remote, pr),
    );
    // Commits on pr/<n> the pull request lacks (made here, or before a force-push): moving the
    // branch would take them off, so they are kept on a branch of their own, after asking.
    let keepAs: string | undefined;
    if (update.own) {
      keepAs = await keepName(root, update.branch);
      const n = update.own;
      const them = n === 1 ? 'it' : 'them';
      const keep = await this.prompts.confirm(
        `${update.branch} has ${n} ${n === 1 ? 'commit' : 'commits'} that pull request #${pr.number} does not: made on ${update.branch} here, or from before the pull request was rewritten (force-pushed). Update ${update.branch} to the pull request?`,
        `Keep ${n === 1 ? 'It' : 'Them'} on ${keepAs} and Update`,
        `${update.branch} moves to the pull request's head; the new branch ${keepAs} keeps ${them}.${update.holder ? ` ${samePath(update.holder, root) ? 'This folder' : `The worktree ${path.basename(update.holder)}`} has ${update.branch} checked out: it moves too, keeping its uncommitted changes.` : ''}`,
      );
      if (!keep) return undefined;
    }
    await movePullBranch(root, update, keepAs);
    const github: GitHubInfo = {
      host: conn.repo.host,
      owner: conn.repo.owner,
      repo: conn.repo.repo,
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
    };
    const out = await checkOut(
      {
        root,
        ref: prBranch(pr),
        place: mode,
        name: `pull request #${pr.number}`,
        purpose: 'pr',
        start: { base, baseSource: 'pr', github },
      },
      this.prompts,
    );
    if (!out) return undefined;
    if (!out.here) return out.dir;
    const started = await vscode.commands.executeCommand<boolean>('reviewDesk.start', {
      base,
      baseSource: 'pr',
      github,
      cwd: root,
    });
    if (!started) return undefined;
    await this.prompts.progress('Importing review threads…', () => this.importThreads(conn));
    return root;
  }

  /**
   * Starts the review a checkout into a worktree left for one of `folders` (this window's,
   * by default), if any: a pull request (its threads are imported too) or a side picked to
   * compare. A new window finds it in its folder; this window, in a worktree added to it.
   * True when a review started.
   */
  async resumePending(folders?: string[]): Promise<boolean> {
    for (const root of folders ??
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)) {
      const pending = await readPending(root);
      if (!pending) continue;
      try {
        // A review of another folder carries nothing over to this one.
        const current = this.controller.target;
        if (current && !samePath(current.root, root)) this.controller.close();
        const started = await vscode.commands.executeCommand<boolean>('reviewDesk.start', {
          cwd: root,
          base: pending.base,
          baseSource: pending.baseSource ?? (pending.github ? 'pr' : 'picked'),
          github: pending.github,
          workTree: pending.workTree,
        });
        if (started && pending.github) {
          await this.prompts.progress('Importing review threads…', () => this.importThreads());
        }
        return !!started;
      } finally {
        await clearPending(root);
      }
    }
    return false;
  }

  /** Replaces the cards imported from GitHub with the PR's current review threads. */
  async importThreads(conn?: Connection): Promise<number> {
    const n = await this.syncThreads({ conn, force: true });
    return n ?? 0;
  }

  /**
   * Brings the pull request's review threads into the review (see applyThreads): new replies
   * to its threads, a note posted from here getting replies. Asks GitHub whether anything
   * changed since the last time first (an ETag), unless `force`. `silent`: no messages, no
   * sign-in. Returns the number of GitHub threads, or undefined when nothing was read.
   */
  private async syncThreads(o: {
    conn?: Connection;
    force?: boolean;
    silent?: boolean;
  }): Promise<number | undefined> {
    const { target } = this.controller;
    const gh =
      this.controller.review?.github ?? (o.silent ? undefined : await this.linkFromBranch(o.conn));
    if (!target || !gh) {
      if (!o.silent) {
        void vscode.window.showInformationMessage(
          'Review Desk: this review is not for a GitHub pull request.',
        );
      }
      return undefined;
    }
    const c =
      o.conn ?? (await this.connect(target.root, o.silent, await this.remoteOf(target.root, gh)));
    if (!c) return undefined;
    const key = `${gh.owner}/${gh.repo}#${gh.number}`;
    this.checks.fire({ running: true });
    let read: Awaited<ReturnType<GitHubClient['reviewCommentsIfChanged']>>;
    try {
      read = await c.client.reviewCommentsIfChanged(
        gh.number,
        o.force ? undefined : this.etags.get(key),
      );
    } catch (e) {
      this.checks.fire({ running: false, error: errorText(e) });
      throw e;
    }
    // Which threads are resolved: asked every time, since resolving adds no comment (the
    // comments may be unchanged). Without it, the threads still come; marks stay as they were.
    const states = await c.client.reviewThreadStates(gh.number).catch((e: unknown) => {
      log().info(`could not read which review threads are resolved: ${errorText(e)}`);
      return undefined;
    });
    this.checks.fire({ running: false, at: Date.now() });
    if (read === 'unchanged') {
      // Whether a mark changed is told by the review synced (another may be open by now, or
      // none); nothing is saved when none did.
      let changed = false;
      if (states) {
        this.controller.mutateAt(pin(target), (r) => {
          changed = r.github?.number === gh.number && applyResolved(r.annotations, states);
          return changed ? undefined : UNCHANGED;
        });
      }
      if (changed) await this.controller.reload();
      return undefined;
    }
    if (read.etag) this.etags.set(key, read.etag);
    // GitHub's pages are read up to a thousand comments: a pull request with more has threads
    // left out (said in the log, where a problem report finds it).
    if (read.comments.length >= 1000) {
      log().warn(
        `PR #${gh.number} has ${read.comments.length}+ review comments: only the first ${read.comments.length} were read.`,
      );
    }
    const me = gh.login ?? (await c.client.login().catch(() => undefined));
    const cache = new Map<string, string[] | null>();
    for (const cm of read.comments) {
      for (const side of ['old', 'new'] as const) {
        const k = `${side}:${cm.path}`;
        if (!cache.has(k)) cache.set(k, await readSide(target, side, cm.path));
      }
    }
    const firstHere = !this.imported.has(key);
    this.imported.add(key);
    this.controller.mutateAt(pin(target), (r) => {
      if (r.github?.number !== gh.number) return UNCHANGED;
      // The first import of the review synced (not of one opened meanwhile): what GitHub has
      // counts as seen.
      const first =
        firstHere && !r.annotations.some((a) => a.source?.type === 'github' || a.postedAs);
      if (me) r.github.login = me;
      r.annotations = applyThreads(
        r.annotations,
        read.comments,
        (side, p, line) => cache.get(`${side}:${p}`)?.[line - 1] ?? '',
        {
          me,
          first,
          posted: new Set((r.github.posted ?? []).flatMap((p) => p.annotationIds)),
        },
      );
      if (states) applyResolved(r.annotations, states);
    });
    await this.controller.reload();
    return read.comments.filter((cm) => !cm.in_reply_to_id).length;
  }

  /**
   * Looks for new replies on the pull request (silently: never asks to sign in), and says so
   * when there are more new ones than last said, with a button to see them. Called on a timer,
   * on coming back to the window, on Fetch and when a review of a pull request opens.
   */
  async checkReplies(reason: 'timer' | 'focus' | 'fetch' | 'open'): Promise<number> {
    const gh = this.controller.review?.github;
    const target = this.controller.target;
    if (!gh || !target || this.checking) return 0;
    const checked = pin(target);
    // Coming back to the window often: not more than once a minute then.
    if (reason === 'focus' && Date.now() - this.checkedAt < 60_000) return 0;
    this.checking = true;
    try {
      this.checkedAt = Date.now();
      await this.syncThreads({ silent: true }).catch((e: unknown) => {
        log().info(`could not check the pull request's replies: ${errorText(e)}`);
      });
    } finally {
      this.checking = false;
    }
    // Another review opened meanwhile: its replies are not this pull request's to tell.
    const now = this.controller.target;
    if (!now || now.gitDir !== checked.gitDir || now.head.sha !== checked.headSha) return 0;
    const fresh = this.newReplyCount();
    if (fresh > this.told && reason !== 'open') {
      void vscode.window
        .showInformationMessage(
          `Review Desk: ${fresh} new ${fresh === 1 ? 'reply' : 'replies'} on PR #${gh.number}.`,
          'Show',
        )
        .then((show) => show && vscode.commands.executeCommand('reviewDesk.showNewReplies'));
    }
    this.told = fresh;
    return fresh;
  }

  /**
   * Reads the pull request on GitHub now (the notes panel's Sync button): how it stands, and
   * every review thread with its replies. Asks to sign in when needed: the reviewer asked.
   */
  async syncNow(): Promise<number> {
    if (!this.controller.review?.github) return 0;
    this.checkedAt = Date.now();
    await this.checkState().catch(() => undefined);
    await this.syncThreads({ force: true }).catch((e: unknown) => {
      showError(`Review Desk: could not read the pull request on GitHub. ${errorText(e)}`, e);
    });
    this.told = this.newReplyCount();
    return this.told;
  }

  /** New GitHub replies in the review, not the reviewer's (see replies.ts). */
  newReplyCount(): number {
    const me = this.controller.review?.github?.login;
    return this.controller.resolved.reduce((n, a) => n + newReplies(a, me).length, 0);
  }

  /**
   * Starts looking for new replies every `reviewDesk.githubCheckMinutes` (0: never), and on
   * coming back to the window. Checks once when a review of another pull request opens.
   */
  watchReplies(): vscode.Disposable {
    let shown = '';
    const timer = setInterval(() => {
      const minutes = setting('githubCheckMinutes');
      if (minutes > 0 && Date.now() - this.checkedAt >= minutes * 60_000) {
        void this.checkReplies('timer');
      }
    }, 30_000);
    return vscode.Disposable.from(
      { dispose: () => clearInterval(timer) },
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && setting('githubCheckMinutes') > 0) void this.checkReplies('focus');
      }),
      this.controller.onDidChange(() => {
        const gh = this.controller.review?.github;
        const key = gh ? `${this.controller.target?.root}#${gh.number}` : '';
        if (key === shown) return;
        shown = key;
        this.told = 0;
        if (gh && setting('githubCheckMinutes') > 0) void this.checkReplies('open');
      }),
    );
  }

  /**
   * Posts a reply to a note's GitHub thread (an imported thread, or the one a note posted
   * from here started), after a yes, and puts it in the note's conversation.
   */
  async postReply(id: string, body: string): Promise<boolean> {
    const text = body.trim();
    const a = this.controller.annotation(id);
    const gh = this.controller.review?.github;
    const root = a && threadRootId(a);
    const { target } = this.controller;
    if (!text || !a || !gh || !root || !target) return false;
    const ok = this.hooks.preview
      ? !!(await this.hooks.preview('reply', text))
      : await this.prompts.confirm(
          `Post this reply on PR #${gh.number}?`,
          'Post Reply',
          text.length > 300 ? `${text.slice(0, 300)}…` : text,
        );
    if (!ok) return false;
    const conn = await this.connect(target.root, false, await this.remoteOf(target.root, gh));
    if (!conn) return false;
    let made: ReviewComment;
    try {
      made = await conn.client.replyToComment(gh.number, root, text);
    } catch (e) {
      showError(`Review Desk: GitHub did not take the reply. ${errorText(e)}`, e);
      return false;
    }
    this.controller.mutateAt(pin(target), (r) => {
      const note = r.annotations.find((x) => x.id === id);
      if (!note) return;
      note.thread = [
        ...(note.thread ?? []),
        {
          from: 'user',
          author: made.user?.login ?? gh.login ?? 'you',
          body: made.body,
          at: made.created_at,
          githubId: made.id,
        },
      ];
      // Seen up to it, never back: a reply may be timed before others already seen.
      if (!note.seenAt || made.created_at > note.seenAt) note.seenAt = made.created_at;
      delete note.reply;
    });
    await this.controller.reload();
    return true;
  }

  /**
   * Attaches the PR to a review whose branch was checked out by the GitHub Pull Requests
   * extension, so its threads can be imported and notes posted.
   */
  private async linkFromBranch(conn?: Connection): Promise<GitHubInfo | undefined> {
    const target = this.controller.target;
    if (!target) return undefined;
    const found = await ghprBranchPr(target.root, target.head.ref);
    if (!found) return undefined;
    const c = conn ?? (await this.connect(target.root));
    if (!c || c.repo.owner !== found.owner || c.repo.repo !== found.repo) return undefined;
    const pr = await c.client.getPull(found.number);
    const info: GitHubInfo = {
      host: c.repo.host,
      owner: found.owner,
      repo: found.repo,
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
    };
    this.controller.mutateAt(pin(target), (r) => {
      r.github = info;
    });
    await this.controller.reload();
    return info;
  }

  /**
   * Posts the AI notes not posted yet to the pull request, after a preview (see postNotes):
   * with PR comments among them, asks whether the notes that explain the code go too.
   */
  async post(): Promise<string | undefined> {
    return this.postWith((gh) => {
      const ask = this.hooks.preview;
      return {
        ask: ask ?? ((_summary, preview) => this.previews.show(preview)),
        offerToOpen: !ask,
        which: async (comments, notes) => {
          const only = 'Post PR Comments Only';
          const picked = await this.prompts.choose(
            `Post to PR #${gh.number}: ${comments} PR ${comments === 1 ? 'comment' : 'comments'} for its author, and ${notes} ${notes === 1 ? 'note that explains' : 'notes that explain'} the code to you. Post the notes too?`,
            [only, 'Post Comments and Notes'],
            'Either way, the review is shown to edit before it is posted.',
          );
          return picked === undefined ? undefined : picked === only ? 'comments' : 'all';
        },
      };
    });
  }

  /** Posts one PR comment to the pull request now, on its own (after a yes). */
  async postComment(id: string): Promise<string | undefined> {
    const card = this.controller.resolved.find((a) => a.id === id && a.kind === 'comment');
    if (!card) return undefined;
    return this.postWith((gh) => ({
      only: new Set([id]),
      offerToOpen: !this.hooks.preview,
      ask: async (summary, preview) =>
        this.hooks.preview
          ? this.hooks.preview(summary, preview)
          : this.prompts.confirm(
              `Post comment ${card.number} to PR #${gh.number}?`,
              'Post',
              `On ${card.file} ${card.resolvedStart === card.resolvedEnd ? card.resolvedStart : `${card.resolvedStart}–${card.resolvedEnd}`}, as it reads in the panel:\n\n${clip(this.controller.annotation(id)?.body ?? card.body, 1200)}`,
            ),
    }));
  }

  /** A post under way (its preview open, or sending): another waits for it to end. */
  private posting = false;

  private async postWith(options: (gh: GitHubInfo) => PostOptions): Promise<string | undefined> {
    if (this.posting) {
      void vscode.window.showInformationMessage(
        'Review Desk: a post to the pull request is under way (its preview may be open). Finish it first.',
      );
      return undefined;
    }
    this.posting = true;
    try {
      return await this.postNow(options);
    } finally {
      this.posting = false;
    }
  }

  private async postNow(options: (gh: GitHubInfo) => PostOptions): Promise<string | undefined> {
    // The notes as stored now: a comment edited a moment ago is posted as edited.
    await this.controller.reload();
    const gh = this.controller.review?.github ?? (await this.linkFromBranch());
    const { target, review } = this.controller;
    if (!target || !review || !gh) {
      void vscode.window.showInformationMessage(
        'Review Desk: this review is not for a GitHub pull request.',
      );
      return undefined;
    }
    const conn = await this.connect(target.root, false, await this.remoteOf(target.root, gh));
    if (!conn) return undefined;
    return postNotes(this.controller, conn.client, gh, options(gh));
  }
}

/** Text cut to about `max` characters, for a dialog. */
function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
