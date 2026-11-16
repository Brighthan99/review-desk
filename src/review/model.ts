import { z } from 'zod';

/**
 * What a note is: an explanation for the reviewer (why, how, risk, context, overview), the
 * reviewer's question, or a comment for the pull request's author, drafted to be posted on it.
 */
export const KINDS = ['overview', 'why', 'how', 'risk', 'question', 'context', 'comment'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABELS: Record<Kind, string> = {
  overview: 'Overview',
  why: 'Why',
  how: 'How',
  risk: 'Risk',
  question: 'Question',
  context: 'Context',
  comment: 'PR Comment',
};

const RefSchema = z.object({ ref: z.string(), sha: z.string() });

const SelectionSchema = z.object({
  file: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

export const ThreadMessageSchema = z.object({
  from: z.enum(['user', 'ai']),
  /** Display name when the message is not the local reviewer's (e.g. a GitHub user). */
  author: z.string().optional(),
  body: z.string(),
  at: z.string(),
  selection: SelectionSchema.optional(),
  /** Written in the Claude Code chat (saved through Review Desk's MCP server). */
  origin: z.literal('chat').optional(),
  /** A comment on GitHub (a reply in a review thread): its id there. */
  githubId: z.number().optional(),
});

export const AnnotationSchema = z.object({
  id: z.string().min(1),
  /** Empty only for a question about the whole change. */
  file: z.string(),
  side: z.enum(['new', 'old']).default('new'),
  /** 0 (with endLine 0) for a note on the whole file, such as a file summary. */
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  /** Text of startLine; for a note on a whole file, the file it describes (`fileDigest`). */
  anchorText: z.string(),
  kind: z.enum(KINDS),
  title: z.string().min(1),
  body: z.string().default(''),
  group: z.string().optional(),
  order: z.number().optional(),
  related: z.array(z.string()).optional(),
  understood: z.boolean().optional(),
  thread: z.array(ThreadMessageSchema).optional(),
  threadSession: z.string().optional(),
  /** Context size of `threadSession` at its last turn, in tokens. */
  threadTokens: z.number().optional(),
  /** The reviewer asked for this explanation and the agent has not finished writing it. */
  pending: z.boolean().optional(),
  /** Written in the Claude Code chat (saved through Review Desk's MCP server). */
  origin: z.literal('chat').optional(),
  /** A PR comment: what the reviewer asked it to say (none: Claude found what to point out). */
  request: z.string().optional(),
  /** Posted to the pull request as this GitHub comment: its thread's replies come here. */
  postedAs: z.object({ commentId: z.number(), url: z.string() }).optional(),
  /** GitHub messages up to this time were seen; later ones (not the reviewer's) are new. */
  seenAt: z.string().optional(),
  /** A reply to its GitHub thread being written (drafted by Claude, or by hand), not posted. */
  reply: z.string().optional(),
  /** Its GitHub thread is resolved, as GitHub last said (by whom, when known). */
  threadResolved: z.object({ by: z.string().optional() }).optional(),
  /**
   * The language Claude's text in it is in (reviewDesk.language when written or translated);
   * unknown for notes written before it was kept, or mixed after a language change.
   */
  language: z.string().optional(),
  /** Set for cards imported from somewhere else, such as a GitHub review thread. */
  source: z
    .object({ type: z.literal('github'), url: z.string(), commentIds: z.array(z.number()) })
    .optional(),
});

export const GitHubInfoSchema = z.object({
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string().optional(),
  headSha: z.string(),
  baseRef: z.string(),
  /** As GitHub last said (checked on Fetch). */
  state: z.enum(['open', 'closed', 'merged']).optional(),
  /** The reviewer's GitHub login: their own replies are not new to them. */
  login: z.string().optional(),
  posted: z
    .array(
      z.object({
        reviewId: z.number(),
        url: z.string(),
        at: z.string(),
        annotationIds: z.array(z.string()),
      }),
    )
    .optional(),
});

export const ReviewSchema = z.object({
  version: z.literal(1),
  base: RefSchema,
  head: RefSchema,
  /** The new side is the working tree (uncommitted edits included) rather than the head commit. */
  workTree: z.boolean().optional(),
  /** The explaining session, with when it last ran and how big it is (see agent/session.ts). */
  session: z
    .object({
      agent: z.enum(['claude-code', 'codex', 'copilot', 'other']),
      id: z.string(),
      usedAt: z.string().optional(),
      tokens: z.number().optional(),
    })
    .optional(),
  status: z.enum(['writing', 'done']).default('writing'),
  /** Summary of the whole change (markdown), written when the reviewer asks for it. */
  overview: z.string().optional(),
  /** The change the summary describes (see `diffDigest`), to tell when it is out of date. */
  overviewOf: z.string().optional(),
  /** The language the summary is in (unknown for one written before it was kept). */
  overviewLanguage: z.string().optional(),
  annotations: z.array(AnnotationSchema).default([]),
  github: GitHubInfoSchema.optional(),
  /**
   * Changed files the reviewer marked viewed, by path: the right side's version then (a git
   * blob id, or `deleted`), so a later change to the file shows as changed since viewed.
   */
  viewed: z.record(z.string(), z.object({ blob: z.string(), at: z.string() })).optional(),
});

export type Annotation = z.infer<typeof AnnotationSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
export type GitHubInfo = z.infer<typeof GitHubInfoSchema>;

/** A note on a whole file (a file summary) rather than on some of its lines. */
export function isFileNote(a: Pick<Annotation, 'file' | 'startLine'>): boolean {
  return !!a.file && a.startLine === 0;
}

/** Where an annotation ended up after checking its anchor against the code. */
export type AnchorState = 'ok' | 'moved' | 'stale';

export interface ResolvedAnnotation extends Annotation {
  /** Display number in reading order, starting at 1. */
  number: number;
  state: AnchorState;
  /** Lines after anchor correction; equal to startLine/endLine when state is 'ok'. */
  resolvedStart: number;
  resolvedEnd: number;
}

export function parseReview(json: unknown): { review: Review } | { error: string } {
  const result = ReviewSchema.safeParse(json);
  if (result.success) return { review: result.data };
  return { error: z.prettifyError(result.error) };
}

/** Reading order: explicit `order` first, then file and line. */
export function sortAnnotations<T extends Annotation>(annotations: T[]): T[] {
  return [...annotations].sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.startLine - b.startLine;
  });
}
