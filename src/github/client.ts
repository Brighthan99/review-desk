import { apiBase, graphqlUrl, type RemoteRepo } from './remote';

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  draft?: boolean;
  state?: 'open' | 'closed';
  merged_at?: string | null;
}

export interface ReviewComment {
  id: number;
  path: string;
  body: string;
  html_url: string;
  created_at: string;
  user: { login: string } | null;
  in_reply_to_id?: number;
  line: number | null;
  start_line?: number | null;
  side?: 'LEFT' | 'RIGHT' | null;
  start_side?: 'LEFT' | 'RIGHT' | null;
  original_line?: number | null;
}

export interface NewReviewComment {
  path: string;
  body: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

/** Whether a review thread is resolved on GitHub, by its first comment. */
export interface ThreadState {
  /** The thread's first comment (its REST id). */
  rootId: number;
  resolved: boolean;
  /** Who resolved it, when it is. */
  by?: string;
}

const THREAD_STATES = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved resolvedBy { login } comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

/** A GraphQL answer: its data, or why not (still a 200). */
interface GraphQLAnswer<T> {
  data?: T;
  errors?: { message: string }[];
}

interface ThreadStatesData {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          isResolved: boolean;
          resolvedBy: { login: string } | null;
          comments: { nodes: { databaseId: number | null }[] };
        }[];
      };
    } | null;
  } | null;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** The few GitHub REST calls the review needs. */
export class GitHubClient {
  private readonly base: string;

  constructor(
    readonly repo: RemoteRepo,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
  ) {
    this.base = apiBase(repo.host);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    etag?: string,
  ): Promise<{ data: T; next?: string; etag?: string; unchanged?: boolean }> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    // The token goes to the API's own host only, whatever a response links to.
    if (new URL(url).origin !== new URL(this.base).origin) {
      throw new GitHubError(0, `Refusing to send the GitHub token to ${new URL(url).origin}`);
    }
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${await this.token()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        // Asked as it was last seen: a 304 when nothing changed, not counted by the rate limit.
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (etag && res.status === 304) return { data: undefined as T, unchanged: true, etag };
    if (!res.ok) {
      let message = `${res.status}`;
      try {
        const err = (await res.json()) as { message?: string; errors?: unknown };
        message =
          `${res.status} ${err.message ?? ''}${err.errors ? ` ${JSON.stringify(err.errors)}` : ''}`.trim();
      } catch {
        // Keep the status.
      }
      throw new GitHubError(res.status, message);
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    return { data: (await res.json()) as T, next, etag: res.headers.get('etag') ?? undefined };
  }

  private async all<T>(path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = path;
    for (let i = 0; url && i < maxPages; i++) {
      const page: { data: T[]; next?: string } = await this.request<T[]>('GET', url);
      out.push(...page.data);
      url = page.next;
    }
    return out;
  }

  private get repoPath(): string {
    return `/repos/${this.repo.owner}/${this.repo.repo}`;
  }

  /** The most open pull requests listed (the newest): another is opened by its address. */
  static readonly PULLS_LISTED = 100;

  listPulls(): Promise<PullRequest[]> {
    return this.all<PullRequest>(
      `${this.repoPath}/pulls?state=open&per_page=50`,
      GitHubClient.PULLS_LISTED / 50,
    );
  }

  /** The open PR whose head is `branch` in this repository, if any. */
  async findOpenPull(branch: string): Promise<PullRequest | undefined> {
    const head = encodeURIComponent(`${this.repo.owner}:${branch}`);
    const { data } = await this.request<PullRequest[]>(
      'GET',
      `${this.repoPath}/pulls?state=open&head=${head}&per_page=1`,
    );
    return data[0];
  }

  async getPull(number: number): Promise<PullRequest> {
    return (await this.request<PullRequest>('GET', `${this.repoPath}/pulls/${number}`)).data;
  }

  listReviewComments(number: number): Promise<ReviewComment[]> {
    return this.all<ReviewComment>(`${this.repoPath}/pulls/${number}/comments?per_page=100`);
  }

  /**
   * The pull request's review comments, unless they are as when GitHub gave `etag` (asked of
   * the first page, which changes with any comment). With the ETag to ask with next time.
   */
  async reviewCommentsIfChanged(
    number: number,
    etag?: string,
  ): Promise<{ comments: ReviewComment[]; etag?: string } | 'unchanged'> {
    const first = await this.request<ReviewComment[]>(
      'GET',
      `${this.repoPath}/pulls/${number}/comments?per_page=100`,
      undefined,
      etag,
    );
    if (first.unchanged) return 'unchanged';
    const comments = [...first.data];
    let url = first.next;
    for (let i = 1; url && i < 10; i++) {
      const page: { data: ReviewComment[]; next?: string } = await this.request<ReviewComment[]>(
        'GET',
        url,
      );
      comments.push(...page.data);
      url = page.next;
    }
    return { comments, etag: first.etag };
  }

  /** The line comments posted with a review, with their ids. */
  listCommentsOfReview(number: number, reviewId: number): Promise<ReviewComment[]> {
    return this.all<ReviewComment>(
      `${this.repoPath}/pulls/${number}/reviews/${reviewId}/comments?per_page=100`,
    );
  }

  /** Replies in the thread of a review comment (its first comment). */
  async replyToComment(number: number, commentId: number, body: string): Promise<ReviewComment> {
    return (
      await this.request<ReviewComment>(
        'POST',
        `${this.repoPath}/pulls/${number}/comments/${commentId}/replies`,
        { body },
      )
    ).data;
  }

  /**
   * Which review threads of the pull request are resolved. Only GraphQL tells it (a REST
   * comment has no such field), and resolving adds no comment, so it is asked every time: one
   * request of the GraphQL rate limit's points (5000 an hour), per 100 threads.
   */
  async reviewThreadStates(number: number): Promise<ThreadState[]> {
    const out: ThreadState[] = [];
    let after = null as string | null;
    for (let i = 0; i < 10; i++) {
      const vars = { owner: this.repo.owner, repo: this.repo.repo, number, after };
      const answer = await this.request<GraphQLAnswer<ThreadStatesData>>(
        'POST',
        graphqlUrl(this.repo.host),
        { query: THREAD_STATES, variables: vars },
      );
      const data: GraphQLAnswer<ThreadStatesData> = answer.data;
      if (data.errors?.length) {
        throw new GitHubError(200, data.errors.map((e) => e.message).join('; '));
      }
      const threads = data.data?.repository?.pullRequest?.reviewThreads;
      if (!threads) break;
      for (const t of threads.nodes) {
        const rootId = t.comments.nodes[0]?.databaseId;
        if (rootId == null) continue;
        out.push({
          rootId,
          resolved: t.isResolved,
          ...(t.isResolved && t.resolvedBy ? { by: t.resolvedBy.login } : {}),
        });
      }
      if (!threads.pageInfo.hasNextPage || !threads.pageInfo.endCursor) break;
      after = threads.pageInfo.endCursor;
    }
    return out;
  }

  /** The login of whom the token is for. */
  async login(): Promise<string> {
    return (await this.request<{ login: string }>('GET', '/user')).data.login;
  }

  async createReview(
    number: number,
    review: {
      commit_id: string;
      body: string;
      event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
      comments: NewReviewComment[];
    },
  ): Promise<{ id: number; html_url: string }> {
    return (
      await this.request<{ id: number; html_url: string }>(
        'POST',
        `${this.repoPath}/pulls/${number}/reviews`,
        review,
      )
    ).data;
  }

  async createFileComment(
    number: number,
    c: { commit_id: string; path: string; body: string },
  ): Promise<{ id: number; html_url: string } | undefined> {
    return (
      await this.request<{ id: number; html_url: string } | undefined>(
        'POST',
        `${this.repoPath}/pulls/${number}/comments`,
        { ...c, subject_type: 'file' },
      )
    ).data;
  }
}
