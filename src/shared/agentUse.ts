// What Review Desk says about the coding agent it runs (Claude Code or Codex): which account
// the runs use, and the notice asked once before the first. No vscode import, so the panel
// and tests share it.

/** The coding agents Review Desk can run: Claude Code, or OpenAI's Codex (ChatGPT). */
export type AgentKind = 'claude' | 'codex';

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex'];

/**
 * How the runs are signed in: a subscription (a Claude plan, a ChatGPT plan: its usage
 * limits) or an API key (billed to its account), as the agent reports it.
 */
export type AgentAuth = 'plan' | 'apiKey';

/** What the panel shows about the agent Review Desk runs. */
export interface AgentInfo {
  agent: AgentKind;
  /** The executable, '' when none was found. */
  path: string;
  /** How the last run was signed in; unknown before the first. */
  auth?: AgentAuth;
  /** The agent's own word for it (Claude: `none`, `ANTHROPIC_API_KEY`…; Codex: `chatgpt`, `apikey`…). */
  source?: string;
}

/**
 * How an agent stands, asked of it (`claude auth status`, `codex login status`): installed,
 * signed in, with which kind of account. The account (an email) is shown, never kept.
 */
export interface AgentStatus {
  kind: AgentKind;
  /** The executable, '' when it is not installed (not found). */
  path: string;
  /** Unknown when the agent could not say. */
  signedIn?: boolean;
  auth?: AgentAuth;
  /** The plan's name (Claude: Max, Pro…). */
  plan?: string;
  /** Who is signed in (Claude says; Codex does not). */
  account?: string;
  /** A cloud provider instead of the agent's own (Claude: Amazon Bedrock, Google Vertex AI…). */
  provider?: string;
  /** The agent's own word for how it signs in, as kept for the panel's label (see authOf). */
  source?: string;
}

/** The status in a few words, for the agent list. */
export function statusText(s: AgentStatus): string {
  if (!s.path) return 'not installed';
  if (s.signedIn === false) return 'not signed in';
  if (s.provider) return s.provider;
  if (s.auth === 'plan')
    return s.kind === 'claude' ? `Claude ${s.plan ? `${s.plan} ` : ''}plan` : 'ChatGPT plan';
  if (s.auth === 'apiKey') return 'API key';
  return s.signedIn ? 'signed in' : 'installed';
}

/** How to sign in to the agent, as a terminal command (with its executable). */
export function signInCommand(kind: AgentKind, path: string): string {
  const exe = /\s/.test(path) ? `"${path}"` : path;
  return kind === 'claude' ? `${exe} auth login` : `${exe} login`;
}

const NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };
const PLANS: Record<AgentKind, string> = { claude: 'Claude', codex: 'ChatGPT' };

export const agentName = (kind: AgentKind): string => NAMES[kind];

/**
 * How a run was signed in, from the agent's own word for it. Claude Code reports
 * `apiKeySource`: `none` when no API key is used, that is, a Claude account (or a cloud
 * provider set up in Claude Code); any other value names where its API key comes from.
 * Codex says so in `codex login status`: `chatgpt` or `apikey` here (others, such as an
 * access token, are neither).
 */
export function authOf(kind: AgentKind, source: string): AgentAuth | undefined {
  if (kind === 'claude') return source === 'none' ? 'plan' : 'apiKey';
  if (source === 'chatgpt') return 'plan';
  if (source === 'apikey') return 'apiKey';
  return undefined;
}

export function noticeTitle(kind: AgentKind): string {
  return `Review Desk runs your ${NAMES[kind]}`;
}

/** The notice asked once before Review Desk first runs the agent. */
export function noticeDetail(kind: AgentKind, path: string): string {
  const name = NAMES[kind];
  return [
    `Notes, answers, summaries, translations and PR comment drafts are written by the ${name} on this computer (${path || (kind === 'claude' ? 'claude' : 'codex')}), with the account it is signed in to.`,
    `Each run counts toward your ${PLANS[kind]} plan's usage limits, or is billed to your API key when ${name} uses one.`,
    `Review Desk runs it only when you ask, and never sees your ${PLANS[kind]} credentials.`,
  ].join('\n\n');
}

/** What a card says when the agent was not run because the notice was not accepted. */
export function notAllowed(kind: AgentKind): string {
  return `Not run: Review Desk runs your ${NAMES[kind]} only after you allow it. Try again to see the notice.`;
}

/** Said when the agent's executable is not found: what to do about it. */
export function notFound(kind: AgentKind): string {
  return kind === 'claude'
    ? 'Claude Code was not found. Install Claude Code and sign in to it (run `claude` once in a terminal), or set reviewDesk.claudePath in your user settings to the full path of the claude executable.'
    : 'Codex was not found. Install it (`npm install -g @openai/codex` or `brew install --cask codex`) and sign in with your ChatGPT account (`codex login`), or set reviewDesk.codexPath in your user settings to the full path of the codex executable.';
}

/** The panel's short label for it. */
export function agentLabel(info: AgentInfo): string {
  const name = NAMES[info.agent];
  if (!info.path) return `${name} not found`;
  if (info.auth === 'plan') return `${name} · ${PLANS[info.agent]} plan`;
  if (info.auth === 'apiKey') return `${name} · API key`;
  return name;
}

/** The panel's longer word on it, on hover. */
export function agentTooltip(info: AgentInfo): string {
  if (!info.path) return notFound(info.agent);
  const name = NAMES[info.agent];
  const runs = `Review Desk runs your ${name} (${info.path}) when you ask.`;
  if (info.auth === 'plan') {
    const elsewhere =
      info.agent === 'claude'
        ? ' (When Claude Code is set up for Amazon Bedrock, Google Vertex AI or Microsoft Foundry, runs are billed there.)'
        : '';
    return `${runs} It is signed in to a ${PLANS[info.agent]} account: each run counts toward your plan's usage limits.${elsewhere}`;
  }
  if (info.auth === 'apiKey') {
    return `${runs} It uses an API key${info.agent === 'claude' && info.source ? ` (${info.source})` : ''}: each run is billed to that key's account.`;
  }
  return `${runs} Which account it uses shows here after its first run. The agent is chosen with reviewDesk.agent.`;
}
