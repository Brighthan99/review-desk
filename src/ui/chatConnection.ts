import { notFound } from '../shared/agentUse';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { realpath } from '../review/realpath';

/** The server's name in Claude Code; its tools show as mcp__review-desk__review and so on. */
export const SERVER_NAME = 'review-desk';
/** Its name before the extension was renamed (Erudite). */
export const LEGACY_SERVER_NAME = 'erudite';

export interface ServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Claude Code's own config file, where `--scope local` registrations are kept per project. */
function claudeConfigFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** The repository a registration serves (its `--repo`). */
export function servedRepo(config: ServerConfig | undefined): string | undefined {
  const i = config?.args.indexOf('--repo') ?? -1;
  return i >= 0 ? config!.args[i + 1] : undefined;
}

/**
 * Lets the Claude Code chat read the review notes: registers Review Desk's MCP server (dist/mcp.js)
 * with Claude Code for the folders a chat about the repository starts in (`places`): the
 * repository, and the folder of the window's chat when that is another one. Registrations live
 * in Claude Code's config (local scope, keyed by the folder's git root); nothing is written
 * into the folders.
 */
export class ChatConnection {
  constructor(
    private readonly extensionPath: string,
    private readonly storage: string,
    private readonly claudePath: () => string,
    private readonly gitPath: string,
  ) {}

  /** The server script, copied out of the extension folder so registrations survive updates. */
  get script(): string {
    return path.join(this.storage, 'mcp.js');
  }

  /** Copies the server script; without `always`, only refreshes an existing copy. */
  installScript(always = false): void {
    if (!always && !fs.existsSync(this.script)) return;
    fs.mkdirSync(this.storage, { recursive: true });
    fs.copyFileSync(path.join(this.extensionPath, 'dist', 'mcp.js'), this.script);
  }

  config(root: string): ServerConfig {
    const git = this.gitPath && this.gitPath !== 'git' ? ['--git', this.gitPath] : [];
    return {
      type: 'stdio',
      // VS Code's own binary runs as node, so the chat needs no node installed.
      command: process.execPath,
      args: [this.script, '--repo', root, ...git],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }

  /** The server Claude Code has registered for a folder under `name`, if any. */
  registered(place: string, name = SERVER_NAME): ServerConfig | undefined {
    let config: { projects?: Record<string, { mcpServers?: Record<string, ServerConfig> }> };
    try {
      config = JSON.parse(fs.readFileSync(claudeConfigFile(), 'utf8'));
    } catch {
      return undefined;
    }
    for (const key of new Set([realpath(place), place])) {
      const server = config.projects?.[key]?.mcpServers?.[name];
      if (server) return server;
    }
    return undefined;
  }

  /** The places registered for the repository's notes. */
  connectedPlaces(root: string, places: string[]): string[] {
    return places.filter((p) => servedRepo(this.registered(p)) === root);
  }

  async connect(root: string, places: string[]): Promise<void> {
    this.installScript(true);
    for (const place of places) await this.register(place, this.config(root));
  }

  async disconnect(root: string, places: string[]): Promise<void> {
    for (const place of this.connectedPlaces(root, places)) {
      await this.claude(place, ['mcp', 'remove', SERVER_NAME, '-s', 'local']);
    }
  }

  /**
   * Re-registers places whose registration no longer matches this install (VS Code moved,
   * another git, the earlier name): Claude Code would fail to start the server otherwise.
   */
  async keepCurrent(root: string, places: string[]): Promise<void> {
    // Connected under the earlier name: connect again under this one, for the review's
    // repository as it is now.
    const legacy = places.filter((p) => this.registered(p, LEGACY_SERVER_NAME));
    // Serving a repository that is gone (its folder renamed or moved): serve this one.
    const moved = places.some((p) => {
      const repo = servedRepo(this.registered(p));
      return repo !== undefined && repo !== root && !fs.existsSync(repo);
    });
    if (moved && !legacy.length) {
      await this.connect(root, places);
      return;
    }
    if (legacy.length) {
      for (const place of legacy) {
        await this.claude(place, ['mcp', 'remove', LEGACY_SERVER_NAME, '-s', 'local']);
      }
      await this.connect(root, places);
      return;
    }
    for (const place of places) {
      const now = this.registered(place);
      const repo = servedRepo(now);
      if (!now || !repo) continue;
      const want = this.config(repo);
      if (now.command !== want.command || now.args.join('\0') !== want.args.join('\0')) {
        this.installScript(true);
        await this.register(place, want);
      }
    }
  }

  private async register(place: string, config: ServerConfig): Promise<void> {
    // add-json refuses a name that is taken, so a new registration replaces the old one.
    if (this.registered(place)) {
      await this.claude(place, ['mcp', 'remove', SERVER_NAME, '-s', 'local']);
    }
    await this.claude(place, [
      'mcp',
      'add-json',
      SERVER_NAME,
      JSON.stringify(config),
      '-s',
      'local',
    ]);
  }

  private claude(cwd: string, args: string[]): Promise<void> {
    const claude = this.claudePath();
    if (!claude) return Promise.reject(new Error(notFound('claude')));
    return new Promise((resolve, reject) => {
      execFile(claude, args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
        if (!error) resolve();
        else reject(new Error((stderr || stdout).trim() || error.message));
      });
    });
  }
}
