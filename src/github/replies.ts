// GitHub replies in a note's conversation: which are new to the reviewer. No vscode import, so
// the extension, the panel's state and tests share it.
import type { Annotation, ThreadMessage } from '../review/model';
import type { ThreadState } from './client';

/** Whether a note carries a GitHub conversation: an imported thread, or a note posted there. */
export function hasGithubThread(a: Pick<Annotation, 'source' | 'postedAs'>): boolean {
  return a.source?.type === 'github' || !!a.postedAs;
}

/** The time of its latest GitHub message, if any. */
export function latestGithubAt(a: Pick<Annotation, 'thread'>): string | undefined {
  return (a.thread ?? [])
    .filter((m) => m.githubId !== undefined)
    .map((m) => m.at)
    .sort()
    .at(-1);
}

/** Its GitHub messages written after it was last seen, by someone other than `me`. */
export function newReplies(a: Pick<Annotation, 'thread' | 'seenAt'>, me?: string): ThreadMessage[] {
  const seen = a.seenAt ?? '';
  return (a.thread ?? []).filter(
    (m) => m.githubId !== undefined && m.at > seen && (!me || m.author !== me),
  );
}

/** The GitHub comment a reply to its thread answers: the thread's first comment. */
export function threadRootId(a: Pick<Annotation, 'source' | 'postedAs'>): number | undefined {
  return a.postedAs?.commentId ?? a.source?.commentIds[0];
}

/**
 * Marks the notes whose GitHub thread is resolved (by its first comment), and unmarks those
 * opened again. A note whose thread GitHub did not list is left as it was. Whether any changed.
 */
export function applyResolved(annotations: Annotation[], states: ThreadState[]): boolean {
  const byRoot = new Map(states.map((s) => [s.rootId, s]));
  let changed = false;
  for (const a of annotations) {
    const root = threadRootId(a);
    const s = root === undefined ? undefined : byRoot.get(root);
    if (!s) continue;
    const was = a.threadResolved;
    if (s.resolved) {
      if (was && was.by === s.by) continue;
      a.threadResolved = s.by ? { by: s.by } : {};
    } else {
      if (!was) continue;
      delete a.threadResolved;
    }
    changed = true;
  }
  return changed;
}
