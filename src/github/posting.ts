import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { ReviewStore } from '../review/store';
import type { GitHubInfo } from '../review/model';
import type { GitHubClient } from './client';
import {
  apiComments,
  applyPreview,
  buildReviewPayload,
  previewDocument,
  type ReviewEvent,
} from './convert';
import { errorText, showError, showWarning } from '../ui/log';

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What the reviewer said to a preview: post it or not, how, and the text as edited. */
export type PreviewAnswer = boolean | { event?: ReviewEvent; text?: string } | undefined;

export interface PostOptions {
  /** Shows the review before posting (`summary` counts its parts) and waits for the answer. */
  ask(summary: string, preview: string): Promise<PreviewAnswer>;
  /** Offers to open the posted review on GitHub. */
  offerToOpen: boolean;
  /** Posts these notes only (a PR comment on its own), without the summary of the change. */
  only?: Set<string>;
  /**
   * With PR comments and explaining notes not posted yet: whether to post the comments only
   * (`comments`), all of them (`all`), or nothing. Not asked: the comments only.
   */
  which?(comments: number, notes: number): Promise<'comments' | 'all' | undefined>;
}

/**
 * Posts the review's AI notes not posted yet to its pull request, after a preview: line
 * comments and the notes in the body as one review (COMMENT, APPROVE or REQUEST_CHANGES),
 * file notes as file comments. Each part is recorded with the review as soon as GitHub has
 * it, so posting again after a failure sends only what is missing. Returns the review's URL.
 */
export async function postNotes(
  controller: ReviewController,
  client: GitHubClient,
  gh: GitHubInfo,
  options: PostOptions,
): Promise<string | undefined> {
  const { target, review, resolved } = controller;
  if (!target || !review) return undefined;
  // Where what is posted gets recorded: this review, whichever is open when it is done.
  const at = { gitDir: target.gitDir, headSha: target.head.sha };
  const latest = await client.getPull(gh.number);
  if (latest.head.sha !== target.head.sha) {
    showError(
      `Review Desk: local HEAD (${target.head.sha.slice(0, 7)}) is not the pull request's latest commit (${latest.head.sha.slice(0, 7)}). Open the pull request again, then post.`,
    );
    return undefined;
  }
  if (target.uncommitted.length) {
    showError(
      `Review Desk: ${count(target.uncommitted.length, 'file')} with uncommitted changes. Commit and push first, so line numbers match the pull request.`,
    );
    return undefined;
  }
  const posted = new Set((gh.posted ?? []).flatMap((p) => p.annotationIds));
  let unposted = resolved.filter(
    (a) =>
      a.kind !== 'question' &&
      !a.source &&
      !posted.has(a.id) &&
      (!options.only || options.only.has(a.id)),
  );
  // PR comments are written for the author; notes explain the code to the reviewer, so with
  // both, the comments go alone unless the reviewer says otherwise.
  const comments = unposted.filter((a) => a.kind === 'comment');
  let commentsOnly = !!options.only || (!!comments.length && comments.length === unposted.length);
  if (!options.only && comments.length && comments.length < unposted.length) {
    const which = options.which
      ? await options.which(comments.length, unposted.length - comments.length)
      : 'comments';
    if (!which) return undefined;
    if (which === 'comments') {
      unposted = comments;
      commentsOnly = true;
    }
  }
  const fresh = new Set(unposted.map((a) => a.id));
  if (!fresh.size) {
    void vscode.window.showInformationMessage(
      options.only
        ? 'Review Desk: that comment is posted already.'
        : 'Review Desk: no new notes to post.',
    );
    return undefined;
  }
  const built = buildReviewPayload(target, review, resolved, fresh, !commentsOnly);
  const summary = `${count(built.comments.length, 'line comment')}, ${count(built.fileComments.length, 'file comment')}, ${count(built.inBody.length, 'note')} in the review body${built.skipped.length ? `, ${built.skipped.length} skipped` : ''}`;
  const preview = previewDocument(built, [
    `# Review preview for PR #${gh.number}`,
    '',
    gh.url,
    '',
    `${summary}. Choose above how to post it: as comments, approving, or requesting changes.`,
  ]);
  const answer = await options.ask(summary, preview);
  if (!answer) return undefined;
  const { event = 'COMMENT', text = preview } = answer === true ? {} : answer;
  // As the reviewer left it: edited, parts deleted. Without what was posted while the
  // preview was open (Post to PR on a card): it would go a second time.
  const edited = applyPreview(built, text);
  const stored = new ReviewStore(at.gitDir).load(at.headSha);
  const since = new Set(
    stored.kind === 'ok'
      ? (stored.review.github?.posted ?? [])
          .flatMap((p) => p.annotationIds)
          .filter((id) => !posted.has(id))
      : [],
  );
  const payload: typeof edited = {
    ...edited,
    comments: edited.comments.filter((c) => !since.has(c.annotationId)),
    fileComments: edited.fileComments.filter((c) => !since.has(c.annotationId)),
    inBody: edited.inBody.filter((id) => !since.has(id)),
  };
  const keepBody = !!payload.body.trim();
  if (!payload.comments.length && !payload.fileComments.length && !keepBody) {
    void vscode.window.showInformationMessage(
      'Review Desk: everything was left out; nothing posted.',
    );
    return undefined;
  }
  // Only file comments left: no empty review, unless it approves or requests changes.
  const sent = { reviewId: 0, url: gh.url };
  const inBody = keepBody ? payload.inBody : [];
  if (payload.comments.length || inBody.length || event !== 'COMMENT') {
    let created: { id: number; html_url: string };
    try {
      created = await client.createReview(gh.number, {
        commit_id: target.head.sha,
        body: payload.body.trim() || (event === 'APPROVE' ? '' : 'See the comments.'),
        event,
        comments: apiComments(payload),
      });
    } catch (e) {
      showError(`Review Desk: GitHub did not take the review. ${errorText(e)}`, e);
      return undefined;
    }
    Object.assign(sent, { reviewId: created.id, url: created.html_url });
    // The GitHub comment each line comment became, so replies to it come to its note.
    const postedAs = new Map<string, { commentId: number; url: string }>();
    const made = await client.listCommentsOfReview(gh.number, created.id).catch(() => []);
    for (const c of payload.comments) {
      const same = made.find(
        (m) =>
          !m.in_reply_to_id &&
          m.path === c.path &&
          m.line === c.line &&
          (m.side ?? 'RIGHT') === c.side &&
          ![...postedAs.values()].some((p) => p.commentId === m.id),
      );
      if (same) postedAs.set(c.annotationId, { commentId: same.id, url: same.html_url });
    }
    recordPosted(
      controller,
      at,
      sent,
      [...payload.comments.map((c) => c.annotationId), ...inBody],
      postedAs,
    );
  }
  const failed: string[] = [];
  for (const fc of payload.fileComments) {
    try {
      const made = await client.createFileComment(gh.number, {
        commit_id: target.head.sha,
        path: fc.path,
        body: fc.body,
      });
      recordPosted(
        controller,
        at,
        sent,
        [fc.annotationId],
        made ? new Map([[fc.annotationId, { commentId: made.id, url: made.html_url }]]) : undefined,
      );
    } catch (e) {
      failed.push(`${fc.path}: ${errorText(e)}`);
    }
  }
  if (failed.length) {
    showWarning(
      `Review Desk: ${count(failed.length, 'file comment')} could not be posted. Posting again sends only those. ${failed.join(' / ')}`,
    );
  } else if (options.offerToOpen) {
    const open = await vscode.window.showInformationMessage(
      `Review Desk: posted the review to PR #${gh.number}.`,
      'Open',
    );
    if (open) await vscode.env.openExternal(vscode.Uri.parse(sent.url));
  }
  return sent.url;
}

/**
 * Adds annotation ids to the posted record of a review (reviewId 0: file comments alone), and
 * to each note the GitHub comment it became: its thread's replies are new after now.
 */
function recordPosted(
  controller: ReviewController,
  at: { gitDir: string; headSha: string },
  review: { reviewId: number; url: string },
  ids: string[],
  postedAs?: Map<string, { commentId: number; url: string }>,
): void {
  const now = new Date().toISOString();
  // The review posted from, even when another is open by now (the preview and GitHub took a
  // while): its record says what was posted, so posting again sends nothing twice.
  controller.mutateAt(at, (r) => {
    if (!r.github) return;
    for (const a of r.annotations) {
      const as = postedAs?.get(a.id);
      if (!as) continue;
      a.postedAs = as;
      a.seenAt = now;
    }
    const list = r.github.posted ?? [];
    const entry = list.find((p) => p.reviewId === review.reviewId && p.url === review.url);
    if (entry) entry.annotationIds.push(...ids);
    else list.push({ ...review, at: new Date().toISOString(), annotationIds: ids });
    r.github.posted = list;
  });
}
