import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

// The part of the built-in git extension's API (extensions/git/src/api/git.d.ts) we use.
interface GitExtensionApi {
  readonly git: { readonly path: string };
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

interface GitExtension {
  getAPI(version: 1): GitExtensionApi;
}

let api: GitExtensionApi | undefined;

export async function gitExtensionApi(): Promise<GitExtensionApi | undefined> {
  if (api) return api;
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    api = exports.getAPI(1);
  } catch {
    api = undefined;
  }
  return api;
}

/** A `git:` URI for a file at a ref, as the git extension builds it. */
export function toGitUri(file: vscode.Uri, ref: string): vscode.Uri {
  if (api) return api.toGitUri(file, ref);
  return file.with({ scheme: 'git', query: JSON.stringify({ path: file.fsPath, ref }) });
}

/** Path and ref of a `git:` URI, or undefined for other schemes. */
export function parseGitUri(uri: vscode.Uri): { path: string; ref: string } | undefined {
  if (uri.scheme !== 'git') return undefined;
  try {
    const q = JSON.parse(uri.query) as { path?: string; ref?: string };
    return q.path && q.ref !== undefined ? { path: q.path, ref: q.ref } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The git executable to run. Uses the one the git extension found; on macOS the
 * /usr/bin/git xcrun shim is swapped for the real binary because parallel calls
 * through the shim are slow.
 */
export async function resolveGitPath(): Promise<string> {
  const found = (await gitExtensionApi())?.git.path ?? 'git';
  if (process.platform !== 'darwin' || (found !== 'git' && found !== '/usr/bin/git')) return found;
  return new Promise((resolve) => {
    execFile('xcrun', ['--find', 'git'], { encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? found : stdout.trim() || found);
    });
  });
}
