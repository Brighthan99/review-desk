export interface RemoteRepo {
  host: string;
  owner: string;
  repo: string;
}

/** owner/repo from a git remote URL (https, ssh, scp-like); undefined if not recognizable. */
export function parseRemote(url: string): RemoteRepo | undefined {
  const u = url.trim();
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  ];
  for (const p of patterns) {
    const m = p.exec(u);
    if (m) return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
  }
  return undefined;
}

/** REST base for github.com or a GitHub Enterprise Server host. */
export function apiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

/** GraphQL endpoint for github.com or a GitHub Enterprise Server host. */
export function graphqlUrl(host: string): string {
  return host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
}
