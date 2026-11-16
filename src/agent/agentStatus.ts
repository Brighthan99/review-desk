import { execFile } from 'node:child_process';
import type { AgentStatus } from '../shared/agentUse';
import { codexAuthFrom } from './codexRunner';

type Account = Omit<AgentStatus, 'kind' | 'path'>;

const PROVIDERS: Record<string, string> = {
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
};

/**
 * How Claude Code is signed in, from `claude auth status --json`: a Claude account
 * (`authMethod` claude.ai: its plan, as `subscriptionType`), an API key (another
 * `authMethod`), or a cloud provider (`apiProvider`).
 */
export function claudeAccountFrom(json: string): Account {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (d.loggedIn === false) return { signedIn: false };
  const provider =
    typeof d.apiProvider === 'string' && d.apiProvider !== 'firstParty'
      ? (PROVIDERS[d.apiProvider] ?? d.apiProvider)
      : undefined;
  const method = typeof d.authMethod === 'string' ? d.authMethod : undefined;
  const plan =
    typeof d.subscriptionType === 'string' && d.subscriptionType
      ? d.subscriptionType[0].toUpperCase() + d.subscriptionType.slice(1)
      : undefined;
  const account = typeof d.email === 'string' && d.email ? d.email : undefined;
  if (method === 'claude.ai') {
    return { signedIn: true, auth: 'plan', plan, account, provider, source: 'none' };
  }
  return {
    signedIn: d.loggedIn === true ? true : undefined,
    auth: method ? 'apiKey' : undefined,
    account,
    provider,
    source: method,
  };
}

/** How Codex is signed in, from `codex login status`. */
export function codexAccountFrom(text: string): Account {
  const source = codexAuthFrom(text);
  if (source === 'none') return { signedIn: false };
  if (source === 'chatgpt') return { signedIn: true, auth: 'plan', source };
  if (source === 'apikey') return { signedIn: true, auth: 'apiKey', source };
  return { signedIn: true };
}

/** Asks the agent how it stands (a quick local command, no AI run). */
export function agentStatus(kind: AgentStatus['kind'], path: string): Promise<AgentStatus> {
  if (!path) return Promise.resolve({ kind, path });
  const args = kind === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
  return new Promise((resolve) => {
    execFile(path, args, { timeout: 10_000 }, (_error, stdout, stderr) => {
      const account =
        kind === 'claude' ? claudeAccountFrom(stdout) : codexAccountFrom(`${stderr}\n${stdout}`);
      resolve({ kind, path, ...account });
    });
  });
}
