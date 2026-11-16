import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import {
  GitHubClient,
  GitHubError,
  type NewReviewComment,
  type PullRequest,
  type ReviewComment,
} from '../../src/github/client';
import { ReviewStore } from '../../src/review/store';
import type { PanelState } from '../../src/shared/protocol';
import type { PullListing } from '../../src/ui/pullPick';
import {
  activate,
  answering,
  fakeCalls,
  run,
  topRow,
  until,
  useFakeClaude,
  workspace,
} from './helpers';

/** A GitHubClient that answers from memory and records what would be posted. */
class FakeGitHub extends GitHubClient {
  pulls: PullRequest[] = [];
  comments: ReviewComment[] = [];
  reviews: { commit_id: string; body: string; comments: NewReviewComment[] }[] = [];
  fileComments: { path: string; body: string }[] = [];
  /** File comments to reject before accepting again. */
  failFileComments = 0;

  constructor() {
    super({ host: 'github.com', owner: 'acme', repo: 'my-app' }, async () => 'token');
  }
  override async listPulls() {
    return this.pulls;
  }
  override async findOpenPull(branch: string) {
    return this.pulls.find((p) => p.head.ref === branch);
  }
  override async getPull(n: number) {
    return this.pulls.find((p) => p.number === n)!;
  }
  /** Replies posted from Review Desk: to which comment, what. */
  replies: { to: number; body: string }[] = [];
  /** Comments each review posted, by review id, as GitHub keeps them. */
  private readonly byReview = new Map<number, ReviewComment[]>();
  private nextId = 5000;
  override async listReviewComments() {
    return this.comments;
  }
  /** As when GitHub answers 304: no comment changed (resolving a thread adds none). */
  commentsUnchanged = false;
  override async reviewCommentsIfChanged() {
    return this.commentsUnchanged ? ('unchanged' as const) : { comments: this.comments };
  }
  /** Resolved threads, by their first comment: who resolved them. */
  resolved = new Map<number, string>();
  /** Called as GitHub is asked which threads are resolved (to leave the review meanwhile). */
  onThreadStates?: () => void;
  override async reviewThreadStates() {
    this.onThreadStates?.();
    return this.comments
      .filter((c) => !c.in_reply_to_id)
      .map((c) => ({
        rootId: c.id,
        resolved: this.resolved.has(c.id),
        ...(this.resolved.get(c.id) ? { by: this.resolved.get(c.id) } : {}),
      }));
  }
  override async listCommentsOfReview(_n: number, reviewId: number) {
    return this.byReview.get(reviewId) ?? [];
  }
  override async login() {
    return 'me-reviewer';
  }
  override async replyToComment(_n: number, to: number, body: string) {
    this.replies.push({ to, body });
    const root = this.comments.find((c) => c.id === to)!;
    const c: ReviewComment = {
      ...root,
      id: this.nextId++,
      body,
      in_reply_to_id: to,
      user: { login: 'me-reviewer' },
      created_at: new Date().toISOString(),
    };
    this.comments.push(c);
    return c;
  }
  override async createReview(
    _n: number,
    r: { commit_id: string; body: string; comments: NewReviewComment[] },
  ) {
    this.reviews.push(r);
    const id = 1000 + this.reviews.length;
    // As GitHub keeps them: each line comment, with an id, the start of a thread.
    const made = r.comments.map((c): ReviewComment => ({
      id: this.nextId++,
      path: c.path,
      body: c.body,
      html_url: `https://github.com/acme/my-app/pull/7#discussion_r${this.nextId}`,
      created_at: new Date().toISOString(),
      user: { login: 'me-reviewer' },
      line: c.line,
      start_line: c.start_line ?? null,
      side: c.side,
    }));
    this.byReview.set(id, made);
    this.comments.push(...made);
    return { id, html_url: `https://github.com/acme/my-app/pull/7#review-${this.reviews.length}` };
  }
  override async createFileComment(_n: number, c: { path: string; body: string }) {
    if (this.failFileComments > 0) {
      this.failFileComments--;
      throw new GitHubError(422, '422 Validation Failed');
    }
    this.fileComments.push(c);
    return { id: this.nextId++, html_url: 'https://github.com/acme/my-app/pull/7#file' };
  }
}

const pull = (number: number, sha: string): PullRequest => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/acme/my-app/pull/${number}`,
  user: { login: 'octocat' },
  head: { ref: `feature-${number}`, sha },
  base: { ref: 'main', sha: '' },
});

describe('GitHub PR (M4)', () => {
  let api: ExtensionApi;
  const fake = new FakeGitHub();
  const previews: string[] = [];
  let bare: string;
  let worktree: string | undefined;
  let restore = () => {};

  before(async () => {
    api = await activate();
    // A local bare repository stands in for GitHub: refs/pull/<n>/head like the real one.
    bare = path.join(path.dirname(workspace()), `${path.basename(workspace())}-origin.git`);
    execFileSync('git', ['clone', '-q', '--bare', workspace(), bare]);
    run('switch', '-q', '-C', 'gh-pr-7', 'fixture-refresh');
    run('commit', '-q', '--allow-empty', '-m', 'PR 7 head');
    run('push', '-q', bare, 'gh-pr-7:refs/pull/7/head');
    run('switch', '-q', '-C', 'gh-pr-8', 'feat/rename');
    run('commit', '-q', '--allow-empty', '-m', 'PR 8 head');
    run('push', '-q', bare, 'gh-pr-8:refs/pull/8/head');
    run('remote', 'add', 'origin', bare);
    fake.pulls = [pull(7, run('rev-parse', 'gh-pr-7')), pull(8, run('rev-parse', 'gh-pr-8'))];
    fake.comments = [
      {
        id: 1,
        path: 'src/auth/session.ts',
        body: 'What if two requests come at once?',
        html_url: 'https://github.com/acme/my-app/pull/7#discussion_r1',
        created_at: '2026-01-01T00:00:00Z',
        user: { login: 'octocat' },
        line: 13,
        start_line: 8,
        side: 'RIGHT',
      },
      {
        id: 2,
        path: 'src/auth/session.ts',
        body: 'The server takes a lock.',
        html_url: 'https://github.com/acme/my-app/pull/7#discussion_r2',
        created_at: '2026-01-02T00:00:00Z',
        user: { login: 'hubot' },
        in_reply_to_id: 1,
        line: 13,
        side: 'RIGHT',
      },
    ];
    restore = answering(api, { openFolder: async () => {} });
    api.github.hooks = {
      connect: async () => ({ client: fake, remote: 'origin', repo: fake.repo }),
      preview: async (_summary, preview) => {
        previews.push(preview);
        return true;
      },
    };
  });

  after(async () => {
    await useFakeClaude(false);
    api.github.hooks = {};
    restore();
    if (worktree) run('worktree', 'remove', '--force', worktree);
    run('remote', 'remove', 'origin');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('checks a PR out on its branch, reviews it against the base and imports its threads', async () => {
    const conn = { client: fake, remote: 'origin', repo: fake.repo };
    assert.strictEqual(await api.github.checkout(conn, fake.pulls[0], 'here'), workspace());
    assert.strictEqual(run('branch', '--show-current'), 'pr/7');
    await until('review on pr/7', () => api.controller.target?.head.sha === fake.pulls[0].head.sha);
    assert.strictEqual(api.controller.target!.base.ref, 'origin/main');
    await until('threads imported', () => api.controller.resolved.some((a) => a.source));
    const gh = api.controller.resolved.find((a) => a.id === 'gh1')!;
    assert.deepStrictEqual(
      [gh.file, gh.resolvedStart, gh.resolvedEnd, gh.kind],
      ['src/auth/session.ts', 8, 13, 'question'],
    );
    assert.deepStrictEqual(
      gh.thread?.map((m) => m.author),
      ['octocat', 'hubot'],
    );
    assert.strictEqual(api.controller.review?.github?.number, 7);
    // The checkout opened the changes editor. Left open while later tests switch branches
    // under it, its inner editors are disposed mid-render, which VS Code logs as "An
    // unexpected bug occurred" (harmless, but noise in the log).
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('keeps local questions on a thread when GitHub has new replies', async () => {
    await useFakeClaude(true);
    await api.panel.receive({
      type: 'ask',
      cardId: 'gh1',
      text: 'Why lock?',
      useSelection: false,
    });
    await until('answered', () => api.controller.annotation('gh1')?.thread?.length === 4);

    fake.comments.push({
      ...fake.comments[1],
      id: 3,
      body: 'The lock lasts 30 seconds.',
      created_at: '2026-01-03T00:00:00Z',
      user: { login: 'octocat' },
    });
    await api.github.importThreads();
    const thread = api.controller.annotation('gh1')!.thread!;
    assert.deepStrictEqual(
      thread.map((m) => [m.author, m.from]),
      [
        ['octocat', 'user'],
        ['hubot', 'user'],
        ['octocat', 'user'],
        [undefined, 'user'],
        [undefined, 'ai'],
      ],
    );
    assert.strictEqual(thread[3].body, 'Why lock?');
    fake.comments.pop();
    await api.github.importThreads();
  });

  it('posts AI notes as one COMMENT review, after a preview, and only once', async () => {
    api.controller.mutate((r) => {
      r.overview = 'The server refreshes the token.';
      r.annotations.push(
        {
          id: 'a1',
          file: 'src/auth/session.ts',
          side: 'new',
          startLine: 8,
          endLine: 13,
          anchorText: 'if (isExpired(token)) {',
          kind: 'how',
          title: 'Refresh in place',
          body: 'One request fewer.',
        },
        {
          id: 'a2',
          file: 'src/auth/token.ts',
          side: 'new',
          startLine: 12,
          endLine: 14,
          anchorText: 'export function isExpired(token: Token): boolean {',
          kind: 'context',
          title: 'Expiry check',
          body: '30 seconds of slack',
        },
      );
    });
    await until('annotations', () => api.controller.resolved.length === 3);

    const url = await api.github.post();
    assert.match(url!, /review-1$/);
    assert.strictEqual(previews.length, 1);
    assert.match(previews[0], /1 line comment, 0 file comments, 1 note in the review body/);
    const [review] = fake.reviews;
    assert.strictEqual(review.commit_id, fake.pulls[0].head.sha);
    assert.deepStrictEqual(
      review.comments.map((c) => [c.path, c.start_line, c.line, c.side]),
      [['src/auth/session.ts', 8, 13, 'RIGHT']],
    );
    assert.match(review.body, /The server refreshes the token\./);
    assert.match(review.body, /src\/auth\/token\.ts/);
    await until('posted recorded', () => api.controller.review?.github?.posted?.length === 1);
    assert.deepStrictEqual(api.controller.review!.github!.posted![0].annotationIds.sort(), [
      'a1',
      'a2',
    ]);

    assert.strictEqual(await api.github.post(), undefined);
    assert.strictEqual(fake.reviews.length, 1);
  });

  it('records each part as it posts, so only a failed file comment is posted again', async () => {
    api.controller.mutate((r) => {
      r.annotations.push({
        id: 'a3',
        file: 'test/auth/session.test.ts',
        side: 'new',
        startLine: 1,
        endLine: 1,
        anchorText: "import { getSession } from '../../src/auth/session';",
        kind: 'how',
        title: 'What is tested',
        body: 'Reading the session',
      });
    });
    await until('a3', () => api.controller.resolved.some((a) => a.id === 'a3'));
    const posted = () => api.controller.review!.github!.posted!.flatMap((p) => p.annotationIds);

    fake.failFileComments = 1;
    await api.github.post();
    assert.match(previews.at(-1)!, /0 line comments, 1 file comment/);
    assert.strictEqual(fake.reviews.length, 1, 'no empty review for file comments alone');
    assert.strictEqual(fake.fileComments.length, 0);
    assert.ok(!posted().includes('a3'));

    await api.github.post();
    assert.deepStrictEqual(
      fake.fileComments.map((c) => c.path),
      ['test/auth/session.test.ts'],
    );
    await until('a3 recorded', () => posted().includes('a3'));
    assert.strictEqual(fake.reviews.length, 1);
  });

  it('records what it posted in the review it posted from, even when another is open by then', async () => {
    api.controller.mutate((r) => {
      r.annotations.push({
        id: 'a9',
        file: 'src/auth/session.ts',
        side: 'new',
        startLine: 8,
        endLine: 8,
        anchorText: 'if (isExpired(token)) {',
        kind: 'risk',
        title: 'Refreshed twice',
        body: 'Two requests can refresh at once.',
      });
    });
    await until('a9', () => api.controller.resolved.some((a) => a.id === 'a9'));
    const t = api.controller.target!;
    const from = { root: t.root, base: t.base.ref, gitDir: t.gitDir, head: t.head.sha };
    const kept = api.github.hooks.preview;
    // The reviewer leaves the review while the preview is open (here: closes it).
    api.github.hooks.preview = async () => {
      api.controller.close();
      return true;
    };
    const reviews = fake.reviews.length;
    try {
      assert.ok(await api.github.post());
      assert.strictEqual(fake.reviews.length, reviews + 1);
      assert.strictEqual(api.controller.target, undefined, 'closed meanwhile');
      const stored = new ReviewStore(from.gitDir).load(from.head);
      assert.ok(
        stored.kind === 'ok' &&
          stored.review.github!.posted!.some((p) => p.annotationIds.includes('a9')),
        'recorded in the review it was posted from',
      );
    } finally {
      api.github.hooks.preview = kept;
      await api.controller.start({ cwd: from.root, base: from.base, open: false });
    }
    // Back on it: posting again sends nothing twice.
    await until('a9 back', () => api.controller.resolved.some((a) => a.id === 'a9'));
    assert.strictEqual(await api.github.post(), undefined);
    assert.strictEqual(fake.reviews.length, reviews + 1);
  });

  it('posts one thing at a time: Post to PR on a card waits while a preview is open', async () => {
    api.controller.mutate((r) => {
      r.annotations.push({
        id: 'c-once',
        file: 'src/auth/session.ts',
        side: 'new',
        startLine: 8,
        endLine: 8,
        anchorText: 'if (isExpired(token)) {',
        kind: 'comment',
        title: 'Guard the refresh',
        body: '**issue:** Guard the refresh',
      });
    });
    await until('c-once', () => api.controller.resolved.some((a) => a.id === 'c-once'));
    const kept = api.github.hooks.preview;
    let release: ((ok: boolean) => void) | undefined;
    api.github.hooks.preview = () => new Promise<boolean>((r) => (release = r));
    const reviews = fake.reviews.length;
    try {
      const first = api.github.post();
      await until('preview open', () => !!release);
      // The card's Post to PR while the preview is open: not a second post of it.
      assert.strictEqual(await api.github.postComment('c-once'), undefined);
      release!(true);
      assert.ok(await first);
      const posted = fake.reviews.slice(reviews).flatMap((r) => r.comments.map((c) => c.body));
      assert.strictEqual(posted.filter((b) => /Guard the refresh/.test(b)).length, 1);
    } finally {
      api.github.hooks.preview = kept;
    }
  });

  it('posts the preview as the reviewer edited it, leaving out deleted parts, as they chose', async () => {
    const note = (id: string, body: string) => ({
      id,
      file: 'src/auth/session.ts',
      side: 'new' as const,
      startLine: 8,
      endLine: 13,
      anchorText: 'if (isExpired(token)) {',
      kind: 'risk' as const,
      title: `Note ${id}`,
      body,
    });
    api.controller.mutate((r) => {
      r.annotations.push(note('a4', 'The note as written'), note('a5', 'A note to leave out'));
    });
    await until(
      'a4 and a5',
      () => api.controller.resolved.filter((a) => /^a[45]$/.test(a.id)).length === 2,
    );
    const kept = api.github.hooks.preview;
    api.github.hooks.preview = async (_summary, text) => {
      previews.push(text);
      // a4 rewritten, a5's part deleted (its marker line up to the next marker).
      const edited = text
        .replace('The note as written', 'A comment rewritten by hand')
        .replace(/<!-- review-desk:line a5 [^\n]*-->\n[\s\S]*?(?=\n\n<!-- review-desk:)/, '');
      return { event: 'REQUEST_CHANGES', text: edited };
    };
    try {
      const before = fake.reviews.length;
      assert.ok(await api.github.post());
      assert.strictEqual(fake.reviews.length, before + 1);
      const posted = fake.reviews.at(-1)! as (typeof fake.reviews)[number] & { event?: string };
      assert.strictEqual(posted.event, 'REQUEST_CHANGES');
      assert.strictEqual(posted.comments.length, 1, 'a5 left out');
      assert.match(posted.comments[0].body, /Note a4/);
      assert.ok(posted.comments[0].body.endsWith('A comment rewritten by hand'), 'as edited');
      await until('a4 recorded', () =>
        api.controller.review!.github!.posted!.some((p) => p.annotationIds.includes('a4')),
      );
      assert.ok(
        !api.controller.review!.github!.posted!.some((p) => p.annotationIds.includes('a5')),
        'the deleted part is not posted, so it can be posted later',
      );
    } finally {
      api.github.hooks.preview = kept;
    }
  });

  it('drafts a PR comment on lines as asked, rewrites and edits it, and posts it alone', async () => {
    await useFakeClaude(true);
    const session = vscode.Uri.file(path.join(workspace(), 'src/auth/session.ts'));
    const id = await vscode.commands.executeCommand<string>(
      'reviewDesk.draftCommentRange',
      session.toString(),
      8,
      8,
      'new',
      'Two requests may refresh at once',
    );
    assert.ok(id);
    const card = () => api.controller.annotation(id)!;
    await until('drafted', () => !card().pending, 20000);
    assert.strictEqual(card().kind, 'comment');
    assert.strictEqual(card().request, 'Two requests may refresh at once');
    assert.strictEqual(card().title, 'May refresh twice at once');
    assert.match(card().body, /^\*\*issue:\*\* May refresh twice at once/);
    const prompt = fakeCalls().at(-1)!.prompt;
    assert.ok(prompt.startsWith('[Review Desk: comment]'));
    assert.match(
      prompt,
      /What the reviewer wants the comment to say: Two requests may refresh at once/,
    );

    // Rewritten as asked below it, the comment as it read sent along.
    await api.panel.receive({ type: 'ask', cardId: id, text: 'Shorter', useSelection: false });
    await until('rewritten', () => card().title === 'Guard the refresh', 20000);
    assert.match(fakeCalls().at(-1)!.prompt, /Rewrite it as the reviewer asks: Shorter/);
    // Edited by hand: posted as it reads.
    await api.panel.receive({
      type: 'editComment',
      id,
      body: '**suggestion:** Refresh only once\n\nPlease take a lock.',
    });
    assert.strictEqual(card().title, 'Refresh only once');

    // Posted alone (a note not posted yet, a5, stays): one line comment, no summary.
    const before = fake.reviews.length;
    assert.ok(await vscode.commands.executeCommand('reviewDesk.github.postComment', id));
    assert.strictEqual(fake.reviews.length, before + 1);
    const posted = fake.reviews.at(-1)!;
    assert.deepStrictEqual(
      posted.comments.map((c) => [c.path, c.line, c.body]),
      [['src/auth/session.ts', 8, '**suggestion:** Refresh only once\n\nPlease take a lock.']],
    );
    assert.doesNotMatch(posted.body, /The server refreshes the token/);
    await until('recorded', () =>
      api.controller.review!.github!.posted!.some((p) => p.annotationIds.includes(id)),
    );
    assert.ok(
      !api.controller.review!.github!.posted!.some((p) => p.annotationIds.includes('a5')),
      'only the comment',
    );
  });

  it('asks whether the notes go with the PR comments, and posts the comments only by default', async () => {
    const session = vscode.Uri.file(path.join(workspace(), 'src/auth/session.ts'));
    const id = await vscode.commands.executeCommand<string>(
      'reviewDesk.draftCommentRange',
      session.toString(),
      9,
      9,
      'new',
      '',
    );
    await until('drafted', () => !api.controller.annotation(id)!.pending, 20000);
    // Asked with nothing to say: Claude finds what is worth pointing out.
    assert.match(fakeCalls().at(-1)!.prompt, /The reviewer did not say what to point out/);
    const asked: string[][] = [];
    const restore = answering(api, {
      choose: async (_message, buttons) => (asked.push(buttons), buttons[0]),
    });
    try {
      const before = fake.reviews.length;
      assert.ok(await api.github.post());
      assert.deepStrictEqual(asked, [['Post PR Comments Only', 'Post Comments and Notes']]);
      const posted = fake.reviews.at(-1)!;
      assert.strictEqual(fake.reviews.length, before + 1);
      assert.deepStrictEqual(
        posted.comments.map((c) => c.line),
        [9],
        'the comment, not the note a5',
      );
    } finally {
      restore();
      await useFakeClaude(false);
    }
  });

  it('brings GitHub replies to the note posted from here, as new, and replies from the panel', async () => {
    // a1 was posted from here (a test above): its GitHub comment was kept.
    const a1 = () => api.controller.annotation('a1')!;
    const root = a1().postedAs?.commentId;
    assert.ok(root, 'the GitHub comment a1 became');
    const thread = () => a1().thread ?? [];
    fake.comments.push({
      ...fake.comments.find((c) => c.id === root)!,
      id: 9001,
      in_reply_to_id: root,
      body: 'Right, I will fix it.',
      user: { login: 'octocat' },
      created_at: new Date(Date.now() + 1000).toISOString(),
    });
    await useFakeClaude(true);
    const kept = api.github.hooks.preview;
    api.github.hooks.preview = async () => true;
    try {
      assert.strictEqual(await api.github.checkReplies('timer'), 1, 'one new reply');
      assert.ok(thread().some((m) => m.githubId === 9001 && m.author === 'octocat'));
      assert.ok(
        !api.controller.resolved.some((a) => a.source?.commentIds.includes(root)),
        'in a1, not a card of its own',
      );
      // Opened: seen.
      await api.panel.select('a1', false);
      await until('seen', () => api.github.newReplyCount() === 0);

      // A reply drafted by Claude, from the thread.
      await api.panel.receive({ type: 'draftReply', id: 'a1' });
      await until('reply drafted', () => a1().reply !== undefined, 20000);
      const prompt = fakeCalls().at(-1)!.prompt;
      assert.ok(prompt.startsWith('[Review Desk: reply]'));
      assert.match(prompt, /<github-message author="octocat">\nRight, I will fix it\./);
      // Posted as edited: a reply in that thread, in a1's conversation, not new to its author.
      await api.panel.receive({ type: 'postReply', id: 'a1', body: 'Thanks!' });
      assert.deepStrictEqual(fake.replies.at(-1), { to: root, body: 'Thanks!' });
      assert.ok(thread().some((m) => m.body === 'Thanks!' && m.author === 'me-reviewer'));
      assert.strictEqual(a1().reply, undefined, 'the draft is gone');
      assert.strictEqual(await api.github.checkReplies('timer'), 0, 'my reply is not new to me');

      // The panel's Sync button: read now, and when it was, shown.
      fake.comments.push({
        ...fake.comments.find((c) => c.id === root)!,
        id: 9002,
        in_reply_to_id: root,
        body: 'One more.',
        user: { login: 'hubot' },
        created_at: new Date(Date.now() + 5000).toISOString(),
      });
      await api.panel.receive({ type: 'syncGithub' });
      assert.ok(
        thread().some((m) => m.githubId === 9002),
        'the new reply in a1',
      );
      assert.strictEqual(api.github.newReplyCount(), 1);
      assert.ok(api.panel.githubCheck?.at && !api.panel.githubCheck.running, 'when it was read');

      // Summed up by Claude, into the conversation.
      await api.panel.receive({ type: 'summarizeThread', id: 'a1' });
      await until('summed up', () => thread().at(-1)?.from === 'ai', 20000);
      assert.match(
        fakeCalls().at(-1)!.prompt,
        /<github-message author="octocat">\nRight, I will fix it\./,
      );
    } finally {
      api.github.hooks.preview = kept;
      await useFakeClaude(false);
    }
  });

  it('marks the notes whose GitHub thread is resolved, even when no comment changed', async () => {
    const a1 = () => api.controller.annotation('a1')!;
    const root = a1().postedAs!.commentId;
    const states: PanelState[] = [];
    const sub = api.panel.host.onDidPost((m) => {
      if (m.type === 'state' && m.state) states.push(m.state);
    });
    const shown = () => states.at(-1)?.cards.find((c) => c.id === 'a1');
    try {
      // Resolved on GitHub: no comment is added, so the comments read as unchanged.
      fake.commentsUnchanged = true;
      fake.resolved.set(root, 'octocat');
      await api.github.checkReplies('timer');
      assert.deepStrictEqual(a1().threadResolved, { by: 'octocat' });
      await until('marked on the card', () => shown()?.resolved === true);
      assert.strictEqual(shown()!.resolvedBy, 'octocat');
      // An imported thread of someone else's, resolved too: its card is marked.
      fake.resolved.set(1, 'hubot');
      await api.github.checkReplies('timer');
      assert.deepStrictEqual(api.controller.annotation('gh1')?.threadResolved, { by: 'hubot' });
      // Read in full again (the Sync button): the marks stay.
      fake.commentsUnchanged = false;
      await api.panel.receive({ type: 'syncGithub' });
      assert.deepStrictEqual(api.controller.annotation('gh1')?.threadResolved, { by: 'hubot' });
      // Opened again on GitHub: unmarked.
      fake.resolved.clear();
      await api.github.checkReplies('timer');
      assert.strictEqual(a1().threadResolved, undefined);
      assert.strictEqual(api.controller.annotation('gh1')?.threadResolved, undefined);
      await until('unmarked on the card', () => shown()?.resolved === undefined);
    } finally {
      fake.commentsUnchanged = false;
      fake.resolved.clear();
      sub.dispose();
    }
  });

  it('marks the review it synced, even when another is open (or none) by the time GitHub answers', async () => {
    const a1 = () => api.controller.annotation('a1')!;
    const root = a1().postedAs!.commentId;
    const t = api.controller.target!;
    const from = { root: t.root, base: t.base.ref, gitDir: t.gitDir, head: t.head.sha };
    // Resolved on GitHub, no comment changed; the reviewer leaves the review while GitHub is
    // asked about the threads.
    fake.commentsUnchanged = true;
    fake.resolved.set(root, 'octocat');
    fake.onThreadStates = () => api.controller.close();
    try {
      // Nothing told of a review no longer open.
      assert.strictEqual(await api.github.checkReplies('timer'), 0);
      assert.strictEqual(api.controller.target, undefined, 'closed meanwhile');
      const stored = new ReviewStore(from.gitDir).load(from.head);
      assert.ok(stored.kind === 'ok');
      assert.deepStrictEqual(
        stored.review.annotations.find((a) => a.id === 'a1')?.threadResolved,
        { by: 'octocat' },
        'marked in the review synced',
      );
    } finally {
      fake.onThreadStates = undefined;
      fake.commentsUnchanged = false;
      fake.resolved.clear();
      await api.controller.start({ cwd: from.root, base: from.base, open: false });
    }
    await until('a1 back', () => !!api.controller.annotation('a1'));
    // Unmarked again for the tests after this one.
    await api.github.checkReplies('timer');
    await until('unmarked', () => api.controller.annotation('a1')?.threadResolved === undefined);
  });

  it('opens the box below the notes for a PR comment, and drafts it from there', async () => {
    await useFakeClaude(true);
    const session = vscode.Uri.file(path.join(workspace(), 'src/auth/session.ts'));
    const before = api.controller.resolved.length;
    // As the Comment link above a block calls it: no question in a dialog, the panel's box.
    await vscode.commands.executeCommand(
      'reviewDesk.draftCommentRange',
      session.toString(),
      10,
      11,
      'new',
    );
    const target = {
      file: 'src/auth/session.ts',
      side: 'new' as const,
      startLine: 10,
      endLine: 11,
    };
    assert.deepStrictEqual(api.panel.composing, target);
    assert.strictEqual(api.controller.resolved.length, before, 'nothing drafted yet');
    const editor = vscode.window.activeTextEditor!;
    assert.deepStrictEqual(
      [editor.selection.start.line + 1, editor.selection.end.line + 1],
      [10, 11],
      'the lines selected in the editor',
    );
    try {
      // What the reviewer typed there (here: nothing, so Claude finds what to say).
      await api.panel.receive({ type: 'draftComment', target, request: '' });
      const card = api.controller.resolved.find(
        (a) => a.kind === 'comment' && a.resolvedStart === 10 && a.resolvedEnd === 11,
      );
      assert.ok(card, 'drafted on the lines');
      assert.strictEqual(api.panel.composing, null, 'the box is done with those lines');
      await until('written', () => !api.controller.annotation(card.id)?.pending, 20000);
      assert.match(fakeCalls().at(-1)!.prompt, /Lines to comment on: src\/auth\/session\.ts 10–11/);
      api.panel.remove(card.id);
    } finally {
      await useFakeClaude(false);
    }
  });

  it('checks how the pull request stands on GitHub, and shows it merged', async () => {
    fake.pulls[0].merged_at = '2026-01-03T00:00:00Z';
    try {
      assert.strictEqual(await api.github.checkState(), 'PR #7 was merged into main.');
      await until('kept', () => api.controller.review?.github?.state === 'merged');
      // A row of its own under the comparison, to finish the review from.
      const finish = api.tree.getTreeItem((await topRow(api, 'finish'))!);
      assert.strictEqual(finish.label, 'PR #7 merged into main');
      assert.strictEqual(finish.description, 'finish review…');
      assert.strictEqual(finish.command?.command, 'reviewDesk.finishReview');
      assert.strictEqual(await api.github.checkState(), undefined, 'no news the second time');
    } finally {
      fake.pulls[0].merged_at = null;
      await api.github.checkState();
    }
    await until(
      'the row gone with the PR open again',
      () => api.controller.review?.github?.state === 'open',
    );
    const ids = (await api.tree.getChildren()).map((n) => api.tree.getTreeItem(n).id);
    assert.ok(!ids.includes('finish'), 'no finish row for an open PR');
  });

  it('shows the preview in an editor, with buttons on top to post it or not', async () => {
    api.controller.mutate((r) => {
      r.annotations.push({
        id: 'a6',
        file: 'src/auth/session.ts',
        side: 'new',
        startLine: 8,
        endLine: 13,
        anchorText: 'if (isExpired(token)) {',
        kind: 'how',
        title: 'Note a6',
        body: 'A note posted with the button',
      });
    });
    await until('a6', () => api.controller.resolved.some((a) => a.id === 'a6'));
    const kept = api.github.hooks.preview;
    api.github.hooks.preview = undefined;
    try {
      const posting = api.github.post();
      await until(
        'preview open',
        () => !!vscode.window.activeTextEditor?.document.getText().includes('review-desk:line a6'),
      );
      const doc = vscode.window.activeTextEditor!.document;
      assert.strictEqual(doc.uri.scheme, 'untitled');
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        doc.uri,
      );
      assert.deepStrictEqual(
        lenses.map((l) => l.command?.title),
        [
          '$(cloud-upload) Post as Comment',
          '$(check) Approve',
          '$(request-changes) Request Changes',
          'Cancel',
        ],
      );
      const cancel = lenses[3].command!;
      await vscode.commands.executeCommand(cancel.command, ...cancel.arguments!);
      assert.strictEqual(await posting, undefined, 'nothing posted');
      await until(
        'preview closed',
        () => !vscode.window.visibleTextEditors.some((e) => e.document === doc),
      );
      assert.ok(
        !api.controller.review!.github!.posted!.some((p) => p.annotationIds.includes('a6')),
      );
    } finally {
      api.github.hooks.preview = kept;
    }
  });

  it('links a branch checked out by the GitHub Pull Requests extension to its PR', async () => {
    run('switch', '-q', '-C', 'feature-7', 'gh-pr-7');
    run('commit', '-q', '--allow-empty', '-m', 'local work on the PR branch');
    run('config', 'branch.feature-7.github-pr-owner-number', 'acme#my-app#7');
    assert.ok(
      await vscode.commands.executeCommand('reviewDesk.start', {
        base: 'origin/main',
        open: false,
      }),
    );
    await until('review on feature-7', () => api.controller.target?.head.ref === 'feature-7');
    const linked = () => api.controller.review?.github?.number;
    assert.strictEqual(linked(), undefined);
    // Every thread on GitHub: the one there from the start, and those posted by earlier tests.
    assert.strictEqual(
      await api.github.importThreads(),
      fake.comments.filter((c) => !c.in_reply_to_id).length,
    );
    assert.strictEqual(linked(), 7);
    await until('imported card', () => api.controller.resolved.some((a) => a.id === 'gh1'));
    run('switch', '-q', 'pr/7');
  });

  it('compares a branch with an open PR against the PR target by default', async () => {
    run('switch', '-q', '-C', 'feature-8', 'gh-pr-8');
    assert.ok(await vscode.commands.executeCommand('reviewDesk.start', { open: false }));
    await until('review on feature-8', () => api.controller.target?.head.ref === 'feature-8');
    assert.strictEqual(api.controller.target!.base.ref, 'origin/main');
    assert.deepStrictEqual(api.controller.baseChoice, {
      ref: 'origin/main',
      source: 'pr',
      detail: '#8',
    });
    run('switch', '-q', 'pr/7');
  });

  it('checks a PR out in its own worktree for a new window', async () => {
    const before = run('branch', '--show-current');
    const conn = { client: fake, remote: 'origin', repo: fake.repo };
    worktree = await api.github.checkout(conn, fake.pulls[1], 'worktree');
    assert.ok(worktree && fs.existsSync(worktree));
    assert.strictEqual(
      execFileSync('git', ['branch', '--show-current'], { cwd: worktree, encoding: 'utf8' }).trim(),
      'pr/8',
    );
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim();
    const pending = JSON.parse(
      fs.readFileSync(path.join(gitDir, 'review-desk-pending.json'), 'utf8'),
    );
    assert.deepStrictEqual([pending.base, pending.github.number], ['origin/main', 8]);
    assert.strictEqual(run('branch', '--show-current'), before, 'this window stays where it was');
  });

  it('sends a PR already open in its own worktree to that window, and updates it', async () => {
    const conn = { client: fake, remote: 'origin', repo: fake.repo };
    const before = run('branch', '--show-current');
    const opened: string[] = [];
    const asked: string[] = [];
    const restoreHere = answering(api, {
      openFolder: async (dir) => void opened.push(dir),
      confirm: async (message) => (asked.push(message), true),
    });
    try {
      // pr/8 is checked out in the worktree of the previous test: not here too.
      const dir = await api.github.checkout(conn, fake.pulls[1], 'here');
      assert.ok(dir && fs.realpathSync(dir) === fs.realpathSync(worktree!));
      assert.match(
        asked[0],
        /has pull request #8 checked out, so it cannot be checked out here too/,
      );
      assert.deepStrictEqual(opened, [dir]);
      assert.strictEqual(run('branch', '--show-current'), before, 'this window stays');
      // Opening it in a worktree again fetches into that worktree instead of failing.
      const again = await api.github.checkout(conn, fake.pulls[1], 'worktree');
      assert.ok(again && fs.realpathSync(again) === fs.realpathSync(worktree!));
    } finally {
      restoreHere();
    }
  });

  it('asks before taking commits made on pr/<n> off it, and keeps them on pr/<n>-before', async () => {
    const conn = { client: fake, remote: 'origin', repo: fake.repo };
    const inWorktree = (...args: string[]) =>
      execFileSync('git', args, { cwd: worktree!, encoding: 'utf8' }).trim();
    inWorktree('commit', '-q', '--allow-empty', '-m', 'made on pr/8');
    const mine = inWorktree('rev-parse', 'HEAD');
    const asked: { message: string; button: string }[] = [];
    let keep = false;
    const restoreHere = answering(api, {
      openFolder: async () => {},
      confirm: async (message, button) => (asked.push({ message, button }), keep),
    });
    try {
      // Said no: nothing moves, nothing opens.
      assert.strictEqual(await api.github.checkout(conn, fake.pulls[1], 'worktree'), undefined);
      assert.match(
        asked[0].message,
        /^pr\/8 has 1 commit that pull request #8 does not: made on pr\/8 here, or from before the pull request was rewritten/,
      );
      assert.strictEqual(asked[0].button, 'Keep It on pr/8-before and Update');
      assert.strictEqual(inWorktree('rev-parse', 'HEAD'), mine, 'pr/8 stays');
      assert.ok(!run('branch', '--list', 'pr/8-before'), 'no branch made');

      keep = true;
      const dir = await api.github.checkout(conn, fake.pulls[1], 'worktree');
      assert.ok(dir && fs.realpathSync(dir) === fs.realpathSync(worktree!));
      assert.strictEqual(inWorktree('rev-parse', 'HEAD'), fake.pulls[1].head.sha, 'moved');
      assert.strictEqual(run('rev-parse', 'pr/8-before'), mine, 'its commit kept');
    } finally {
      restoreHere();
      if (run('branch', '--list', 'pr/8-before')) run('branch', '-q', '-D', 'pr/8-before');
    }
  });

  it('opens a pull request from its address (pasted into Comparing with), through the remote that points at its repository', async () => {
    // A second remote naming the repository by its GitHub address; git fetches it from the
    // local stand-in instead.
    const linked = () => api.controller.review?.github?.number;
    const address = 'https://github.com/acme/my-app.git';
    run('remote', 'add', 'upstream', address);
    run('config', `url.${bare}.insteadOf`, address);
    // Pasted into the Comparing with row's list (any tab of the pull request).
    const restoreHere = answering(api, {
      pickPlace: async () => 'here',
      pickSide: async () => ({ pullUrl: 'https://github.com/acme/my-app/pull/7/files' }),
    });
    try {
      const opened = await vscode.commands.executeCommand<string>('reviewDesk.compare');
      assert.strictEqual(fs.realpathSync(opened), fs.realpathSync(workspace()));
      await until('review against upstream', () => linked() === 7);
      assert.strictEqual(api.controller.target?.base.ref, 'upstream/main', 'fetched from upstream');
      assert.strictEqual(api.controller.target?.head.sha, fake.pulls[0].head.sha);
      assert.strictEqual(run('branch', '--show-current'), 'pr/7');

      // Not a pull request, or a repository not open here: told so, nothing checked out.
      assert.strictEqual(
        await vscode.commands.executeCommand(
          'reviewDesk.github.openUrl',
          'https://github.com/other/repo/pull/7',
        ),
        undefined,
      );
    } finally {
      restoreHere();
      run('config', '--unset', `url.${bare}.insteadOf`);
      run('remote', 'remove', 'upstream');
    }
  });

  it('lists the open pull requests to pick one from, and takes any by its address too', async () => {
    const linked = () => api.controller.review?.github?.number;
    const address = 'https://github.com/acme/my-app.git';
    run('remote', 'add', 'upstream', address);
    run('config', `url.${bare}.insteadOf`, address);
    let listing: PullListing | undefined;
    const asked: string[] = [];
    const restoreHere = answering(api, {
      // Where to check it out: #7 here; #8 (in its own worktree already) not at all.
      pickPlace: async (q) => {
        asked.push(q.title);
        return q.title.startsWith('#7 ') ? 'here' : undefined;
      },
      pickSide: async () => 'pull',
      pickPull: async (load) => {
        listing = await load(false);
        return 'pulls' in listing ? { pr: listing.pulls[1] } : undefined;
      },
    });
    try {
      // Compare… › Pull Request…: the open ones of the repository here; #8 picked.
      assert.strictEqual(await vscode.commands.executeCommand('reviewDesk.compare'), undefined);
      assert.ok(listing && 'pulls' in listing, 'listed');
      assert.deepStrictEqual(
        listing.pulls.map((p) => p.number),
        [7, 8],
      );
      assert.strictEqual(listing.repo, 'acme/my-app');
      assert.deepStrictEqual(asked, ['#8 PR 8']);

      // Open Pull Request by Its Address… without one: the same list, where an address typed
      // or pasted in opens that pull request.
      answering(api, { pickPull: async () => ({ url: 'https://github.com/acme/my-app/pull/7' }) });
      const opened = await vscode.commands.executeCommand<string>('reviewDesk.github.openUrl');
      assert.strictEqual(fs.realpathSync(opened), fs.realpathSync(workspace()));
      assert.deepStrictEqual(asked, ['#8 PR 8', '#7 PR 7']);
      await until('review of #7', () => linked() === 7);
      assert.strictEqual(run('branch', '--show-current'), 'pr/7');
    } finally {
      restoreHere();
      run('config', '--unset', `url.${bare}.insteadOf`);
      run('remote', 'remove', 'upstream');
    }
  });
});
