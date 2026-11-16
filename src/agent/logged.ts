import type { AgentRunner, RunRequest, RunResult } from './runner';

export interface RunLog {
  info(line: string): void;
  warn(line: string): void;
}

/**
 * `runner`, with each run logged: how it started (session, model, prompt size, cost limit)
 * and how it ended (time, cost, context, or the error). Never the prompt or the answer.
 */
export function loggedRunner(runner: AgentRunner, log: RunLog): AgentRunner {
  let runs = 0;
  return {
    run(request, onText) {
      const n = ++runs;
      const started = Date.now();
      log.info(`claude #${n}: ${describeRequest(request)}`);
      const handle = runner.run(request, onText);
      void handle.done.then((result) => {
        const line = `claude #${n}: ${describeResult(result, Date.now() - started)}`;
        if (result.error && result.error !== 'Cancelled.') log.warn(line);
        else log.info(line);
      });
      return handle;
    },
  };
}

export function describeRequest(r: RunRequest): string {
  const session = r.resume
    ? `${r.fork ? 'forking' : 'continuing'} session ${r.resume.slice(0, 8)}`
    : 'new session';
  return [
    session,
    `model ${r.model || 'default'}`,
    `tools ${r.tools || 'none'}`,
    `prompt ${r.prompt.length} chars`,
    r.maxBudgetUsd !== undefined && `limit $${r.maxBudgetUsd}`,
    `in ${r.cwd}`,
  ]
    .filter(Boolean)
    .join(', ');
}

export function describeResult(r: RunResult, ms: number): string {
  const facts = [
    `${(ms / 1000).toFixed(1)} s`,
    r.costUsd !== undefined && `$${r.costUsd.toFixed(3)}`,
    r.contextTokens && `context ${Math.round(r.contextTokens / 1000)}k tokens`,
    r.sessionId && `session ${r.sessionId.slice(0, 8)}`,
  ]
    .filter(Boolean)
    .join(', ');
  if (r.error === 'Cancelled.') return `cancelled (${facts})`;
  if (r.error) return `failed (${facts}): ${r.error}`;
  return `done (${facts}), ${r.text.length} chars`;
}
