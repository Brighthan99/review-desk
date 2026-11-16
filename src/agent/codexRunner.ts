import { execFile, spawn } from 'node:child_process';
import { notFound } from '../shared/agentUse';
import type { AgentRunner, RunHandle, RunRequest, RunResult } from './runner';

/**
 * Codex sessions (threads) are kept with this mark, so a session of the other agent is never
 * resumed by this one, nor one of this by Claude Code (both are UUIDs).
 */
export const CODEX_SESSION = 'codex:';

export const isCodexSession = (id: string | undefined): boolean =>
  !!id && id.startsWith(CODEX_SESSION);

/**
 * `codex exec` arguments for a run; the prompt goes to its standard input (`-`).
 *
 * - `--json`: events as JSON lines (see CodexJsonParser).
 * - `--sandbox read-only`: commands it runs may read, never write; Codex's tools cannot be
 *   narrowed down to reading files as Claude Code's are.
 * - `--ignore-user-config`: not the user's ~/.codex/config.toml (its sign-in still counts).
 *   Its MCP servers would otherwise be the agent's tools too, a write-capable one (GitHub,
 *   say) within reach of instructions hidden in the code under review; Claude Code runs with
 *   none either (--strict-mcp-config). Its model choice and profiles go with it:
 *   reviewDesk.codexModel picks the model.
 * - `web_search="disabled"`: Codex searches the web by default (cached results); reading the
 *   change needs no search, and a search query is a way out for what it read.
 * - A session of Codex's own is continued (`resume`), or branched off (`fork`) for a question
 *   on a card; any other (Claude Code's) is not, and a new one starts.
 * - reviewDesk.effort as `model_reasoning_effort`, a config override.
 * - No cost limit: Codex has none to pass (reviewDesk.maxBudgetUsd is Claude Code's).
 */
export function codexArgs(r: RunRequest): string[] {
  const args = [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '-c',
    'web_search="disabled"',
  ];
  if (r.model) args.push('--model', r.model);
  if (r.effort) args.push('-c', `model_reasoning_effort="${r.effort}"`);
  const session = isCodexSession(r.resume) ? r.resume!.slice(CODEX_SESSION.length) : undefined;
  if (session) args.push(r.fork ? 'fork' : 'resume', session);
  args.push('-');
  return args;
}

/**
 * Folds `codex exec --json` lines into the answer: the latest agent message (one before a
 * command it runs is set aside by the next), the thread as the session, its usage, and how
 * it failed. Codex sends a message whole, not as it is written.
 */
export class CodexJsonParser {
  sessionId: string | undefined;
  text = '';
  error: string | undefined;
  contextTokens: number | undefined;
  finished = false;

  /** Returns true when the visible text changed. */
  push(line: string): boolean {
    if (!line.trim()) return false;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    switch (msg.type) {
      case 'thread.started':
        if (typeof msg.thread_id === 'string') this.sessionId = CODEX_SESSION + msg.thread_id;
        return false;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = msg.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          this.text = item.text;
          return true;
        }
        return false;
      }
      case 'turn.completed': {
        const usage = msg.usage as Record<string, unknown> | undefined;
        const n = (k: string) => (typeof usage?.[k] === 'number' ? (usage[k] as number) : 0);
        this.contextTokens = n('input_tokens') + n('output_tokens');
        this.finished = true;
        return false;
      }
      case 'turn.failed': {
        const error = msg.error as { message?: string } | undefined;
        this.error = error?.message || 'Codex stopped with an error.';
        this.finished = true;
        return true;
      }
      case 'error':
        if (typeof msg.message === 'string') this.error = msg.message;
        return false;
      default:
        return false;
    }
  }
}

/**
 * How Codex is signed in, from `codex login status` (which says so on stderr): `chatgpt`,
 * `apikey`, `none` (not signed in) or `other`. The key itself, shown masked there, is never
 * kept or logged.
 */
export function codexAuthFrom(statusText: string): string {
  if (/Logged in using ChatGPT/i.test(statusText)) return 'chatgpt';
  if (/API key/i.test(statusText)) return 'apikey';
  if (/Not logged in/i.test(statusText)) return 'none';
  return 'other';
}

export class CodexCliRunner implements AgentRunner {
  private auth: { at: number; source: string } | undefined;

  constructor(private readonly codexPath: () => string) {}

  /** How Codex is signed in, asked again after a while (one quick local command). */
  private authSource(codex: string, cwd: string): Promise<string> {
    if (this.auth && Date.now() - this.auth.at < 10 * 60_000) {
      return Promise.resolve(this.auth.source);
    }
    return new Promise((resolve) => {
      execFile(codex, ['login', 'status'], { cwd, timeout: 10_000 }, (_e, stdout, stderr) => {
        const source = codexAuthFrom(`${stderr}\n${stdout}`);
        this.auth = { at: Date.now(), source };
        resolve(source);
      });
    });
  }

  run(request: RunRequest, onText: (text: string) => void): RunHandle {
    const codex = this.codexPath();
    if (!codex)
      return { cancel: () => {}, done: Promise.resolve({ text: '', error: notFound('codex') }) };
    const parser = new CodexJsonParser();
    const child = spawn(codex, codexArgs(request), {
      cwd: request.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let cancelled = false;
    let stderr = '';
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (parser.push(line)) onText(parser.text);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const done = new Promise<RunResult>((resolve) => {
      child.on('error', (e) =>
        resolve({ text: parser.text, error: `Could not run codex: ${e.message}` }),
      );
      child.on('close', (code) => {
        if (buffer && parser.push(buffer)) onText(parser.text);
        const base = {
          sessionId: parser.sessionId,
          text: parser.text,
          contextTokens: parser.contextTokens,
        };
        const finish = (result: RunResult) =>
          void this.authSource(codex, request.cwd).then((authSource) =>
            resolve({ ...result, authSource }),
          );
        if (cancelled) resolve({ ...base, error: 'Cancelled.' });
        else if (parser.error && !(parser.finished && parser.text && !code)) {
          finish({ ...base, error: parser.error });
        } else if (!parser.finished) {
          finish({
            ...base,
            error:
              stderr.trim().split('\n').slice(-3).join('\n') ||
              `Codex exited without finishing (code ${code}).`,
          });
        } else finish(base);
      });
    });
    // The agent may stop before it has read the whole prompt (a bad flag, no sign-in): writing
    // the rest then fails (EPIPE). Its exit says what went wrong; unhandled, this error would
    // be thrown in the extension host.
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.prompt);
    return {
      cancel: () => {
        cancelled = true;
        child.kill('SIGTERM');
      },
      done,
    };
  }
}
