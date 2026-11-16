/**
 * When to continue an agent session and when to start over. Continuing a session sends its
 * whole history again; the API's prompt cache makes that cheap only for a few minutes after
 * its last turn. After that (or once the history is big) a new session costs less: the
 * prompts carry what the agent needs (file list, diff, the note and its conversation).
 */

/** Idle time after which the prompt cache of a session has expired. */
export const SESSION_IDLE_MS = 5 * 60 * 1000;
/** Context size from which a session is started over even while its cache is warm. */
export const SESSION_MAX_TOKENS = 100_000;

export interface SessionUse {
  /** When the session last ran (ISO time). */
  usedAt?: string;
  /** Context size at its last turn, in tokens. */
  tokens?: number;
}

/** Whether continuing the session is still cheaper than starting a new one. */
export function worthContinuing(use: SessionUse | undefined, now = Date.now()): boolean {
  const last = use?.usedAt ? Date.parse(use.usedAt) : NaN;
  const idle = now - last;
  if (!(idle >= 0 && idle < SESSION_IDLE_MS)) return false;
  return (use?.tokens ?? 0) < SESSION_MAX_TOKENS;
}

/**
 * Whether the session `id` is of the agent that runs now: a Codex session is marked (see
 * codexRunner), a Claude Code one is not. One of the other agent (the agent was switched
 * within the minutes a session is continued) is not continued: a new session starts, and its
 * prompt must say everything a first one does.
 */
export function ofAgent(id: string | undefined, agent: 'claude' | 'codex' | undefined): boolean {
  return !!id && id.startsWith('codex:') === (agent === 'codex');
}
