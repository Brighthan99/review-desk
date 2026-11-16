import { notFound } from '../shared/agentUse';
import { spawn } from 'node:child_process';

export interface RunRequest {
  prompt: string;
  cwd: string;
  /** Session to continue. */
  resume?: string;
  /** Start a new session from `resume` instead of appending to it. */
  fork?: boolean;
  /** Built-in tools the agent may use, e.g. "Read,Grep,Glob". */
  tools: string;
  maxBudgetUsd?: number;
  /** The setting behind `maxBudgetUsd`, named when a run stops at the limit. */
  budgetSetting?: string;
  /** Model alias or name; empty keeps the session's default. */
  model?: string;
  /** The agent to run it (the one whose notice allowed it); else the one chosen now. */
  agent?: 'claude' | 'codex';
  /** How hard the model thinks (claude --effort: low, medium, high, xhigh, max); empty: its default. */
  effort?: string;
}

export interface RunResult {
  sessionId?: string;
  text: string;
  error?: string;
  costUsd?: number;
  /** Context size at the last turn, in tokens: how much continuing the session will send. */
  contextTokens?: number;
  /** How the run was signed in, in its own words (`none`: a Claude account; else an API key's source). */
  authSource?: string;
}

export interface RunHandle {
  cancel(): void;
  readonly done: Promise<RunResult>;
}

/** Runs one headless agent turn and streams the answer text as it grows. */
export interface AgentRunner {
  run(request: RunRequest, onText: (text: string) => void): RunHandle;
}

export function claudeArgs(r: RunRequest): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  // The user's own Claude Code settings only: not those of the code under review (its
  // .claude/settings.json), whose hooks would run commands and whose env could send the
  // request elsewhere, when anyone can commit them in a pull request.
  args.push('--setting-sources', 'user');
  args.push('--tools', r.tools);
  // No MCP servers: Review Desk's own runs need none (not even its chat server), and each one
  // would add start-up time and tool definitions to every run.
  args.push('--strict-mcp-config');
  // A Codex session (see codexRunner.ts) is not Claude Code's to resume: a new one starts.
  if (r.resume && !r.resume.startsWith('codex:')) {
    args.push('--resume', r.resume);
    if (r.fork) args.push('--fork-session');
  }
  if (r.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(r.maxBudgetUsd));
  if (r.model) args.push('--model', r.model);
  if (r.effort) args.push('--effort', r.effort);
  return args;
}

/**
 * Folds `claude -p --output-format stream-json` lines into the text of the answer.
 * Partial deltas build the current assistant message; a new message (after a tool call)
 * starts over, so the panel shows the latest message. The final `result` wins.
 */
export class StreamJsonParser {
  sessionId: string | undefined;
  text = '';
  error: string | undefined;
  costUsd: number | undefined;
  contextTokens: number | undefined;
  authSource: string | undefined;
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
    if (typeof msg.session_id === 'string') this.sessionId = msg.session_id;
    if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.apiKeySource === 'string') {
      this.authSource = msg.apiKeySource;
    }

    if (msg.type === 'stream_event') {
      const event = msg.event as
        { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (event?.type === 'message_start') {
        this.text = '';
        return true;
      }
      if (
        event?.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        event.delta.text
      ) {
        this.text += event.delta.text;
        return true;
      }
      return false;
    }

    if (msg.type === 'assistant') {
      const usage = (msg.message as { usage?: Record<string, unknown> } | undefined)?.usage;
      if (usage) {
        const n = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
        this.contextTokens =
          n('input_tokens') +
          n('cache_creation_input_tokens') +
          n('cache_read_input_tokens') +
          n('output_tokens');
      }
      return false;
    }

    if (msg.type === 'result') {
      this.finished = true;
      if (typeof msg.total_cost_usd === 'number') this.costUsd = msg.total_cost_usd;
      if (msg.is_error || msg.subtype !== 'success') {
        const detail =
          typeof msg.result === 'string' && msg.result ? msg.result : String(msg.subtype);
        this.error = detail;
        return true;
      }
      if (typeof msg.result === 'string') this.text = msg.result;
      return true;
    }
    return false;
  }
}

/** Readable form of a result error: claude reports a reached cost limit by its subtype alone. */
function describeError(error: string, r: RunRequest): string {
  if (error !== 'error_max_budget_usd') return error;
  const limit = r.maxBudgetUsd !== undefined ? ` of $${r.maxBudgetUsd.toFixed(2)}` : '';
  const raise = r.budgetSetting
    ? ` To allow more, raise ${r.budgetSetting} in the settings and try again.`
    : '';
  return `Stopped at the cost limit${limit} before finishing.${raise}`;
}

export class ClaudeCliRunner implements AgentRunner {
  constructor(private readonly claudePath: () => string) {}

  run(request: RunRequest, onText: (text: string) => void): RunHandle {
    const parser = new StreamJsonParser();
    const claude = this.claudePath();
    if (!claude) {
      return { cancel: () => {}, done: Promise.resolve({ text: '', error: notFound('claude') }) };
    }
    const child = spawn(claude, claudeArgs(request), {
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
        resolve({ text: parser.text, error: `Could not run claude: ${e.message}` }),
      );
      child.on('close', (code) => {
        if (buffer && parser.push(buffer)) onText(parser.text);
        const base = {
          sessionId: parser.sessionId,
          text: parser.text,
          costUsd: parser.costUsd,
          contextTokens: parser.contextTokens,
          authSource: parser.authSource,
        };
        if (cancelled) resolve({ ...base, error: 'Cancelled.' });
        else if (parser.error) resolve({ ...base, error: describeError(parser.error, request) });
        else if (!parser.finished) {
          resolve({
            ...base,
            error: stderr.trim() || `The agent exited without finishing (code ${code}).`,
          });
        } else resolve(base);
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
