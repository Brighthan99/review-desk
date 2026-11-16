import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, type ReviewComment } from '../../src/github/client';
import {
  apiComments,
  applyPreview,
  applyThreads,
  buildReviewPayload,
  previewDocument,
  threadsToAnnotations,
  type ReviewPayload,
} from '../../src/github/convert';
import { applyResolved, newReplies } from '../../src/github/replies';
import { parseGhprConfig } from '../../src/github/checkout';
import { parsePullUrl } from '../../src/github/prUrl';
import { apiBase, graphqlUrl, parseRemote } from '../../src/github/remote';
import { resolveAnnotations } from '../../src/review/anchor';
import type { Annotation, Review } from '../../src/review/model';
import { computeTarget, type ReviewTarget } from '../../src/review/target';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

describe('parseRemote', () => {
  it('reads owner and repo from the usual remote URL forms', () => {
    const want = { host: 'github.com', owner: 'acme', repo: 'my-app' };
    expect(parseRemote('https://github.com/acme/my-app.git')).toEqual(want);
    expect(parseRemote('https://user@github.com/acme/my-app')).toEqual(want);
    expect(parseRemote('git@github.com:acme/my-app.git')).toEqual(want);
    expect(parseRemote('ssh://git@github.com:22/acme/my-app.git')).toEqual(want);
    expect(parseRemote('https://ghe.corp.example/acme/my-app')).toEqual({
      ...want,
      host: 'ghe.corp.example',
    });
    expect(parseRemote('/local/path/repo.git')).toBeUndefined();
  });

  it('points enterprise hosts at /api/v3', () => {
    expect(apiBase('github.com')).toBe('https://api.github.com');
    expect(apiBase('ghe.corp.example')).toBe('https://ghe.corp.example/api/v3');
    expect(graphqlUrl('github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlUrl('ghe.corp.example')).toBe('https://ghe.corp.example/api/graphql');
  });
});

describe('parsePullUrl', () => {
  it('reads a pull request from its address, any tab of it, or owner/repo#n', () => {
    const want = { host: 'github.com', owner: 'acme', repo: 'my-app', number: 12 };
    expect(parsePullUrl('https://github.com/acme/my-app/pull/12')).toEqual(want);
    expect(parsePullUrl(' https://www.github.com/acme/my-app/pull/12/files ')).toEqual(want);
    expect(parsePullUrl('github.com/acme/my-app/pull/12#discussion_r1')).toEqual(want);
    expect(parsePullUrl('https://github.com/acme/my-app/pull/12?w=1')).toEqual(want);
    expect(parsePullUrl('acme/my-app#12')).toEqual(want);
    expect(parsePullUrl('https://ghe.corp.example/acme/my-app/pull/12')).toEqual({
      ...want,
      host: 'ghe.corp.example',
    });
  });

  it('turns down what is not a pull request', () => {
    expect(parsePullUrl('https://github.com/acme/my-app')).toBeUndefined();
    expect(parsePullUrl('https://github.com/acme/my-app/issues/12')).toBeUndefined();
    expect(parsePullUrl('main')).toBeUndefined();
    expect(parsePullUrl('')).toBeUndefined();
  });
});

describe('parseGhprConfig', () => {
  it('reads the PR recorded by the GitHub Pull Requests extension', () => {
    expect(parseGhprConfig('acme#my-app#42\n')).toEqual({
      owner: 'acme',
      repo: 'my-app',
      number: 42,
    });
    expect(parseGhprConfig(null)).toBeUndefined();
    expect(parseGhprConfig('acme/my-app#42')).toBeUndefined();
  });
});

describe('GitHubClient', () => {
  const repo = { host: 'github.com', owner: 'acme', repo: 'app' };

  it('follows pagination links and sends the token', async () => {
    const seen: { url: string; auth: string }[] = [];
    const client = new GitHubClient(
      repo,
      async () => 'tok',
      async (url, init) => {
        seen.push({ url, auth: init.headers.Authorization });
        const page = url.includes('page=2') ? [{ id: 2 }] : [{ id: 1 }];
        return {
          ok: true,
          status: 200,
          headers: {
            get: (n: string) =>
              n === 'link' && !url.includes('page=2') ? `<${url}&page=2>; rel="next"` : null,
          },
          json: async () => page,
          text: async () => '',
        };
      },
    );
    const comments = await client.listReviewComments(7);
    expect(comments.map((c) => c.id)).toEqual([1, 2]);
    expect(seen[0]).toEqual({
      url: 'https://api.github.com/repos/acme/app/pulls/7/comments?per_page=100',
      auth: 'Bearer tok',
    });
  });

  it('never sends the token to a link on another host', async () => {
    const seen: string[] = [];
    const client = new GitHubClient(
      repo,
      async () => 'tok',
      async (url) => {
        seen.push(url);
        return {
          ok: true,
          status: 200,
          headers: {
            get: (n: string) => (n === 'link' ? '<https://evil.example/steal>; rel="next"' : null),
          },
          json: async () => [{ id: 1 }],
          text: async () => '',
        };
      },
    );
    await expect(client.listReviewComments(7)).rejects.toThrow(/evil\.example/);
    expect(seen).toEqual(['https://api.github.com/repos/acme/app/pulls/7/comments?per_page=100']);
  });

  it('asks for review comments as last seen (an ETag), and hears when they are unchanged', async () => {
    const sent: (string | undefined)[] = [];
    const client = new GitHubClient(
      repo,
      async () => 'tok',
      async (_url, init) => {
        const tag = init.headers['If-None-Match'];
        sent.push(tag);
        const same = tag === '"v1"';
        return {
          ok: !same,
          status: same ? 304 : 200,
          headers: { get: (n: string) => (n === 'etag' ? '"v1"' : null) },
          json: async () => [{ id: 1 }],
          text: async () => '',
        };
      },
    );
    const first = await client.reviewCommentsIfChanged(7);
    expect(first).toEqual({ comments: [{ id: 1 }], etag: '"v1"' });
    expect(await client.reviewCommentsIfChanged(7, '"v1"')).toBe('unchanged');
    expect(sent).toEqual([undefined, '"v1"']);
  });

  it('asks GraphQL which review threads are resolved, page by page', async () => {
    const asked: { url: string; method: string; variables: Record<string, unknown> }[] = [];
    const pages = [
      {
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
        nodes: [
          {
            isResolved: true,
            resolvedBy: { login: 'octocat' },
            comments: { nodes: [{ databaseId: 10 }] },
          },
          { isResolved: false, resolvedBy: null, comments: { nodes: [{ databaseId: 20 }] } },
        ],
      },
      {
        pageInfo: { hasNextPage: false, endCursor: null },
        // Resolved by someone gone (no login), and a thread with no comment left.
        nodes: [
          { isResolved: true, resolvedBy: null, comments: { nodes: [{ databaseId: 30 }] } },
          { isResolved: true, resolvedBy: null, comments: { nodes: [] } },
        ],
      },
    ];
    const client = new GitHubClient(
      repo,
      async () => 'tok',
      async (url, init) => {
        const { variables } = JSON.parse(init.body!) as { variables: Record<string, unknown> };
        asked.push({ url, method: init.method, variables });
        const reviewThreads = pages[asked.length - 1];
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ data: { repository: { pullRequest: { reviewThreads } } } }),
          text: async () => '',
        };
      },
    );
    expect(await client.reviewThreadStates(7)).toEqual([
      { rootId: 10, resolved: true, by: 'octocat' },
      { rootId: 20, resolved: false },
      { rootId: 30, resolved: true },
    ]);
    expect(asked.map((a) => [a.url, a.method, a.variables.after])).toEqual([
      ['https://api.github.com/graphql', 'POST', null],
      ['https://api.github.com/graphql', 'POST', 'c1'],
    ]);
    expect(asked[0].variables).toMatchObject({ owner: 'acme', repo: 'app', number: 7 });
  });

  it('fails when GraphQL answers with errors', async () => {
    const client = new GitHubClient(
      repo,
      async () => 'tok',
      async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ errors: [{ message: 'Resource not accessible' }] }),
        text: async () => '',
      }),
    );
    await expect(client.reviewThreadStates(7)).rejects.toThrow('Resource not accessible');
  });

  it('finds the open PR of a branch', async () => {
    const urls: string[] = [];
    const client = new GitHubClient(
      repo,
      async () => 'tok',
      async (url) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () =>
            url.includes('feature%2Fx') ? [{ number: 9, base: { ref: 'develop' } }] : [],
          text: async () => '',
        };
      },
    );
    expect((await client.findOpenPull('feature/x'))?.number).toBe(9);
    expect(await client.findOpenPull('other')).toBeUndefined();
    expect(urls[0]).toBe(
      'https://api.github.com/repos/acme/app/pulls?state=open&head=acme%3Afeature%2Fx&per_page=1',
    );
  });

  it('turns API errors into GitHubError with the message', async () => {
    const client = new GitHubClient(
      repo,
      async () => 'tok',
      async () => ({
        ok: false,
        status: 422,
        headers: { get: () => null },
        json: async () => ({ message: 'Validation Failed', errors: [{ field: 'line' }] }),
        text: async () => '',
      }),
    );
    const err = await client.getPull(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).message).toBe('422 Validation Failed [{"field":"line"}]');
  });
});

describe('review conversion', () => {
  let repo: FixtureRepo;
  let target: ReviewTarget;

  beforeAll(async () => {
    repo = fixtureCopy();
    target = await computeTarget(repo.dir);
  });
  afterAll(() => removeFixture(repo));

  const ann = (
    a: Partial<Annotation> &
      Pick<Annotation, 'id' | 'file' | 'startLine' | 'endLine' | 'anchorText' | 'kind'>,
  ): Annotation => ({
    side: 'new',
    title: a.id,
    body: `${a.id} body`,
    ...a,
  });

  it('maps annotations to line comments inside hunks, file comments, body notes and skips', async () => {
    const review: Review = {
      version: 1,
      base: target.base,
      head: target.head,
      status: 'done',
      overview: 'The summary.',
      annotations: [],
    };
    const resolved = await resolveAnnotations(target, [
      ann({
        id: 'range',
        file: 'src/auth/session.ts',
        startLine: 8,
        endLine: 13,
        anchorText: 'if (isExpired(token)) {',
        kind: 'how',
        order: 1,
      }),
      ann({
        id: 'old',
        file: 'src/auth/session.ts',
        side: 'old',
        startLine: 5,
        endLine: 5,
        anchorText: 'const token = req.cookies.token;',
        kind: 'why',
        order: 2,
      }),
      ann({
        id: 'outside',
        file: 'test/auth/session.test.ts',
        startLine: 1,
        endLine: 1,
        anchorText: "import { getSession } from '../../src/auth/session';",
        kind: 'why',
        order: 3,
      }),
      ann({
        id: 'ctx',
        file: 'src/auth/token.ts',
        startLine: 12,
        endLine: 14,
        anchorText: 'export function isExpired(token: Token): boolean {',
        kind: 'context',
        order: 4,
      }),
      ann({
        id: 'stale',
        file: 'src/auth/session.ts',
        startLine: 2,
        endLine: 2,
        anchorText: 'gone',
        kind: 'risk',
        order: 5,
      }),
      ann({
        id: 'q',
        file: '',
        startLine: 0,
        endLine: 0,
        anchorText: '',
        kind: 'question',
        order: 6,
      }),
      ann({
        id: 'gh',
        file: 'src/auth/session.ts',
        startLine: 8,
        endLine: 8,
        anchorText: 'if (isExpired(token)) {',
        kind: 'question',
        order: 7,
        source: { type: 'github', url: 'u', commentIds: [1] },
      }),
    ]);
    const p = buildReviewPayload(target, review, resolved);
    expect(apiComments(p)).toEqual([
      {
        path: 'src/auth/session.ts',
        body: '**1. range** · _How_\n\nrange body',
        line: 13,
        side: 'RIGHT',
        start_line: 8,
        start_side: 'RIGHT',
      },
      {
        path: 'src/auth/session.ts',
        body: '**2. old** · _Why_\n\nold body',
        line: 5,
        side: 'LEFT',
      },
    ]);
    expect(p.fileComments).toEqual([
      {
        path: 'test/auth/session.test.ts',
        body: '**3. outside** · _Why_\n\noutside body\n\n_(lines 1–1)_',
        annotationId: 'outside',
      },
    ]);
    expect(p.inBody).toEqual(['ctx']);
    expect(p.body).toContain('The summary.');
    expect(p.body).toContain('`src/auth/token.ts` 12–14: **4. ctx** · _Context_ ctx body');
    expect(p.skipped.map((s) => s.id)).toEqual(['stale', 'q', 'gh']);
    expect(
      buildReviewPayload(target, review, resolved, new Set(['old'])).comments.map(
        (c) => c.annotationId,
      ),
    ).toEqual(['old']);
  });

  it('posts a note on a whole file as a file comment, or in the body for a file outside the PR', async () => {
    const review: Review = {
      version: 1,
      base: target.base,
      head: target.head,
      status: 'done',
      annotations: [],
    };
    const note = { startLine: 0, endLine: 0, anchorText: '', kind: 'overview' as const };
    const resolved = await resolveAnnotations(target, [
      ann({ id: 'changed', file: 'src/auth/session.ts', ...note, order: 1 }),
      ann({ id: 'unchanged', file: 'src/auth/token.ts', ...note, order: 2 }),
    ]);
    const p = buildReviewPayload(target, review, resolved);
    expect(p.comments).toEqual([]);
    expect(p.fileComments.map((c) => [c.path, c.annotationId])).toEqual([
      ['src/auth/session.ts', 'changed'],
    ]);
    expect(p.fileComments[0].body).not.toContain('_(lines');
    expect(p.inBody).toEqual(['unchanged']);
    expect(p.body).toContain('- `src/auth/token.ts`: ');
  });

  it('clamps a range that runs past its hunk', async () => {
    const review: Review = {
      version: 1,
      base: target.base,
      head: target.head,
      status: 'done',
      annotations: [],
    };
    // test/auth/session.test.ts: the hunk covers new lines 3–10.
    const resolved = await resolveAnnotations(target, [
      ann({
        id: 't',
        file: 'test/auth/session.test.ts',
        startLine: 2,
        endLine: 7,
        anchorText: '',
        kind: 'how',
      }),
    ]);
    const [c] = buildReviewPayload(target, review, resolved).comments;
    expect([c.start_line, c.line]).toEqual([3, 7]);
  });

  it('posts a PR comment as it is written, its suggestion only where it replaces those lines', async () => {
    const review: Review = {
      version: 1,
      base: target.base,
      head: target.head,
      status: 'done',
      overview: 'Summary for the reviewer.',
      annotations: [],
    };
    const lines = repo.git('show', 'HEAD:test/auth/session.test.ts').split('\n');
    const comment = (id: string, startLine: number, endLine: number, side: 'new' | 'old' = 'new') =>
      ann({
        id,
        file: 'test/auth/session.test.ts',
        startLine,
        endLine,
        side,
        anchorText: lines[startLine - 1],
        kind: 'comment',
        title: 'Rename it',
        body: '**nitpick:** Rename it\n\n```suggestion\nconst renamed = 1;\n```',
      });
    // test/auth/session.test.ts: the hunk covers new lines 3–10.
    const resolved = await resolveAnnotations(target, [comment('in', 4, 5), comment('past', 2, 5)]);
    const p = buildReviewPayload(target, review, resolved, undefined, false);
    const byId = (id: string) => p.comments.find((c) => c.annotationId === id)!;
    const [inside, clamped] = [byId('in'), byId('past')];
    expect(inside.body).toBe('**nitpick:** Rename it\n\n```suggestion\nconst renamed = 1;\n```');
    expect([clamped.start_line, clamped.line]).toEqual([3, 5]);
    expect(clamped.body).toBe('**nitpick:** Rename it\n\n```\nconst renamed = 1;\n```');
    // Posted on their own: no summary of the change in the review body.
    expect(p.body).not.toContain('Summary for the reviewer.');
    expect(buildReviewPayload(target, review, resolved).body).toContain(
      'Summary for the reviewer.',
    );
  });

  it('groups GitHub review comments into threads', () => {
    const base = {
      html_url: 'https://github.com/x',
      user: { login: 'octocat' },
      side: 'RIGHT' as const,
    };
    const comments: ReviewComment[] = [
      {
        ...base,
        id: 2,
        path: 'src/auth/session.ts',
        body: 'Is that right?',
        created_at: '2026-01-02',
        in_reply_to_id: 1,
        line: 13,
      },
      {
        ...base,
        id: 1,
        path: 'src/auth/session.ts',
        body: 'What about concurrency here?\nDetails',
        created_at: '2026-01-01',
        line: 13,
        start_line: 8,
      },
      {
        ...base,
        id: 3,
        path: 'README.md',
        body: 'An old comment',
        created_at: '2026-01-03',
        line: null,
      },
    ];
    const cards = threadsToAnnotations(comments, (side, p, line) => `${side}:${p}:${line}`);
    expect(
      cards.map((c) => [
        c.id,
        c.file,
        c.startLine,
        c.endLine,
        c.anchorText,
        c.title,
        c.thread?.length,
      ]),
    ).toEqual([
      [
        'gh1',
        'src/auth/session.ts',
        8,
        13,
        'new:src/auth/session.ts:8',
        'What about concurrency here?',
        2,
      ],
      ['gh3', '', 0, 0, '', '[README.md] An old comment', 1],
    ]);
    expect(cards[0].thread?.map((m) => m.author)).toEqual(['octocat', 'octocat']);
    expect(cards[0].source).toEqual({
      type: 'github',
      url: 'https://github.com/x',
      commentIds: [1, 2],
    });
  });
});

describe('GitHub threads in the notes', () => {
  const comment = (c: Partial<ReviewComment> & Pick<ReviewComment, 'id' | 'body' | 'created_at'>) =>
    ({
      path: 'src/a.ts',
      html_url: `https://github.com/x#${c.id}`,
      user: { login: 'octocat' },
      line: 5,
      side: 'RIGHT',
      ...c,
    }) as ReviewComment;
  const note = (a: Partial<Annotation>): Annotation => ({
    id: 'n1',
    file: 'src/a.ts',
    side: 'new',
    startLine: 4,
    endLine: 5,
    anchorText: '',
    kind: 'comment',
    title: 'Use a map',
    body: '**suggestion:** Use a map',
    ...a,
  });
  const text = () => '';

  it("puts the replies to a note posted from here in that note, and others' threads in cards", () => {
    const comments = [
      comment({
        id: 10,
        body: '**suggestion:** Use a map',
        created_at: '2026-01-01',
        user: { login: 'me' },
      }),
      comment({ id: 11, body: 'Will do', created_at: '2026-01-03', in_reply_to_id: 10 }),
      comment({ id: 20, body: 'Why not a set?', created_at: '2026-01-02', path: 'src/b.ts' }),
    ];
    const asked = { from: 'user' as const, body: 'Is it right?', at: '2026-01-02T12:00:00Z' };
    const notes = applyThreads(
      [note({ postedAs: { commentId: 10, url: 'u' }, seenAt: '2026-01-01', thread: [asked] })],
      comments,
      text,
      { me: 'me', first: false, posted: new Set(['n1']) },
    );
    const [n1, card] = notes;
    expect(n1.thread?.map((m) => [m.author, m.body])).toEqual([
      [undefined, 'Is it right?'],
      ['octocat', 'Will do'],
    ]);
    expect(newReplies(n1, 'me').map((m) => m.githubId)).toEqual([11]);
    expect(card.id).toBe('gh20');
    // A thread that appears after the first import is new.
    expect(newReplies(card, 'me').map((m) => m.githubId)).toEqual([20]);
  });

  it('finds a note posted before its comment was kept, by who wrote it and where', () => {
    const comments = [
      comment({ id: 30, body: 'old post', created_at: '2026-01-01', user: { login: 'me' } }),
      comment({ id: 31, body: 'reply', created_at: '2026-01-05', in_reply_to_id: 30 }),
    ];
    const [n1, ...rest] = applyThreads([note({})], comments, text, {
      me: 'me',
      first: true,
      posted: new Set(['n1']),
    });
    expect(n1.postedAs).toEqual({ commentId: 30, url: 'https://github.com/x#30' });
    expect(rest).toEqual([]);
    // The first import: what GitHub has counts as seen.
    expect(newReplies(n1, 'me')).toEqual([]);
  });

  it('keeps questions asked on an imported thread, and what was seen of it', () => {
    const comments = [
      comment({ id: 40, body: 'Hm?', created_at: '2026-01-01' }),
      comment({ id: 41, body: 'Yes', created_at: '2026-01-04', in_reply_to_id: 40 }),
    ];
    const old: Annotation = {
      ...threadsToAnnotations([comments[0]], text)[0],
      seenAt: '2026-01-01',
      reply: 'draft',
    };
    old.thread = [...(old.thread ?? []), { from: 'user', body: 'local q', at: '2026-01-02' }];
    const [card] = applyThreads([old], comments, text, { first: false, posted: new Set() });
    expect(card.thread?.map((m) => m.body)).toEqual(['Hm?', 'local q', 'Yes']);
    expect(card.reply).toBe('draft');
    expect(newReplies(card).map((m) => m.body)).toEqual(['Yes']);
  });

  it('marks the notes whose thread is resolved, and unmarks those opened again', () => {
    const posted = note({ postedAs: { commentId: 10, url: 'u' } });
    const card = threadsToAnnotations(
      [comment({ id: 20, body: 'Hm?', created_at: '2026-01-01' })],
      text,
    )[0];
    const local = note({ id: 'n2' });
    const all = [posted, card, local];
    expect(
      applyResolved(all, [
        { rootId: 10, resolved: true, by: 'octocat' },
        { rootId: 20, resolved: true },
      ]),
    ).toBe(true);
    expect([posted.threadResolved, card.threadResolved, local.threadResolved]).toEqual([
      { by: 'octocat' },
      {},
      undefined,
    ]);
    // As it was: nothing to save.
    expect(applyResolved(all, [{ rootId: 10, resolved: true, by: 'octocat' }])).toBe(false);
    // Opened again; a thread GitHub did not list stays as it was.
    expect(applyResolved(all, [{ rootId: 10, resolved: false }])).toBe(true);
    expect([posted.threadResolved, card.threadResolved]).toEqual([undefined, {}]);
  });

  it('keeps the mark of an imported thread when its comments are read again', () => {
    const comments = [comment({ id: 40, body: 'Hm?', created_at: '2026-01-01' })];
    const old: Annotation = {
      ...threadsToAnnotations(comments, text)[0],
      threadResolved: { by: 'me' },
    };
    const [card] = applyThreads([old], comments, text, { first: false, posted: new Set() });
    expect(card.threadResolved).toEqual({ by: 'me' });
  });
});

describe('the preview of a review', () => {
  it('keeps a body that holds a marker-like line whole, and the other parts apart', () => {
    const payload: ReviewPayload = {
      body: 'Summary.',
      comments: [
        {
          path: 'a.ts',
          line: 3,
          side: 'RIGHT',
          annotationId: 'n1',
          body: 'Splits the preview at\n<!-- review-desk:line n2 · b.ts 1 (RIGHT) -->\nlines like this one.',
        },
        { path: 'b.ts', line: 1, side: 'RIGHT', annotationId: 'n2', body: 'Second.' },
      ],
      fileComments: [],
      inBody: [],
      skipped: [],
    };
    const back = applyPreview(payload, previewDocument(payload, ['# Preview']));
    expect(back.comments.map((c) => [c.annotationId, c.body])).toEqual([
      [
        'n1',
        'Splits the preview at\n <!-- review-desk:line n2 · b.ts 1 (RIGHT) -->\nlines like this one.',
      ],
      ['n2', 'Second.'],
    ]);
  });
});
