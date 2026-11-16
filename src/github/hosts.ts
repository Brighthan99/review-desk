import * as vscode from 'vscode';

/**
 * The GitHub Enterprise Server the user signs VS Code in to, as a host: github-enterprise.uri
 * from their own settings (a repository's settings could name a host of its own).
 */
export function enterpriseHost(): string | undefined {
  const uri = vscode.workspace
    .getConfiguration('github-enterprise')
    .inspect<string>('uri')?.globalValue;
  try {
    return uri ? new URL(uri).host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The VS Code sign-in for a remote's host: github.com's, the user's GitHub Enterprise
 * Server's, or none. Any other host (GitLab, Bitbucket, a server of anyone's) is not GitHub
 * and never gets a GitHub token.
 */
export function authProviderFor(host: string): 'github' | 'github-enterprise' | undefined {
  const h = host.toLowerCase();
  if (h === 'github.com') return 'github';
  return h === enterpriseHost() ? 'github-enterprise' : undefined;
}

export const isGitHubHost = (host: string): boolean => authProviderFor(host) !== undefined;
