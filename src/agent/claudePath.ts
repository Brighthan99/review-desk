import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ClaudeLookup {
  /** reviewDesk.claudePath from the user's settings (never a repository's). */
  configured: string;
  /** The PATH to look in. */
  pathEnv: string;
  /** The user's home folder: Claude Code's own installer puts it in ~/.local/bin. */
  home?: string;
  /** Where the Claude Code extension is installed, when it is. */
  bundledDir?: string;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
}

/**
 * The claude executable to run, as an absolute path, or '' when there is none. Only absolute
 * paths: a relative one (in the setting, or a relative PATH entry such as `.`) would be found
 * in the folder under review, which anyone can commit a program to; and a bare `claude` is
 * looked up in the current folder first on Windows.
 *
 * Looked for in order: the setting; each absolute PATH entry; ~/.local/bin (Claude Code's own
 * installer, often missing from the PATH of a VS Code started from the Dock or Start menu);
 * the binary bundled with the Claude Code extension. On Windows, an npm install leaves
 * `claude.cmd` on the PATH, which cannot be run without a shell: the claude.exe it starts,
 * in the npm package next to it, is run instead.
 */
export function resolveClaudePath(o: ClaudeLookup): string {
  const exists = o.exists ?? ((f: string) => fs.existsSync(f));
  const configured = o.configured.trim();
  if (configured) return path.isAbsolute(configured) && exists(configured) ? configured : '';
  const windows = (o.platform ?? process.platform) === 'win32';
  const join = windows ? path.win32.join : path.join;
  const absolute = windows ? path.win32.isAbsolute : path.isAbsolute;
  const exe = windows ? 'claude.exe' : 'claude';
  const delimiter = windows ? ';' : path.delimiter;
  for (const dir of o.pathEnv.split(delimiter)) {
    if (!dir || !absolute(dir)) continue;
    if (exists(join(dir, exe))) return join(dir, exe);
    if (windows && exists(join(dir, 'claude.cmd'))) {
      const npm = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (exists(npm)) return npm;
    }
  }
  const installed = o.home && join(o.home, '.local', 'bin', exe);
  if (installed && absolute(installed) && exists(installed)) return installed;
  const bundled = o.bundledDir && join(o.bundledDir, 'resources', 'native-binary', exe);
  return bundled && exists(bundled) ? bundled : '';
}
