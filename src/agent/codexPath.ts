import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CodexLookup {
  /** reviewDesk.codexPath from the user's settings (never a repository's). */
  configured: string;
  /** The PATH to look in. */
  pathEnv: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (file: string) => boolean;
  /** Where a symlink leads (an npm install links its bin to a script). */
  realpath?: (file: string) => string;
}

/** Rust's name for the platform, as the npm package's native binaries are laid out. */
function targetTriple(platform: NodeJS.Platform, arch: string): string | undefined {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
  if (!cpu) return undefined;
  if (platform === 'darwin') return `${cpu}-apple-darwin`;
  if (platform === 'linux') return `${cpu}-unknown-linux-musl`;
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`;
  return undefined;
}

/**
 * The codex executable to run, as an absolute path, or '' when there is none: the setting
 * (absolute only), else `codex` on an absolute PATH entry (as resolveClaudePath, for the
 * same reasons).
 *
 * An npm install (`npm install -g @openai/codex`) puts a Node script on the PATH (a link on
 * macOS and Linux, `codex.cmd` on Windows) that starts the native binary of the platform
 * package next to it. That script needs `node` on the PATH, which a VS Code started from the
 * Dock or Start menu may not have; so the native binary is run directly. Homebrew and the
 * standalone installers put the native binary on the PATH itself.
 */
export function resolveCodexPath(o: CodexLookup): string {
  const exists = o.exists ?? ((f: string) => fs.existsSync(f));
  const realpath =
    o.realpath ??
    ((f: string) => {
      try {
        return fs.realpathSync(f);
      } catch {
        return f;
      }
    });
  const configured = o.configured.trim();
  const platform = o.platform ?? process.platform;
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const exe = windows ? 'codex.exe' : 'codex';
  const triple = targetTriple(platform, o.arch ?? process.arch);
  const target = platform === 'win32' ? 'win32' : platform;
  const cpu = (o.arch ?? process.arch) === 'arm64' ? 'arm64' : 'x64';
  /** The native binary of an npm install whose package is at `pkg`. */
  const native = (pkg: string): string => {
    if (!triple) return '';
    const vendor = (dir: string) => p.join(dir, 'vendor', triple, 'bin', exe);
    const platformPkg = `codex-${target}-${cpu}`;
    const candidates = [
      vendor(p.join(pkg, 'node_modules', '@openai', platformPkg)),
      vendor(p.join(p.dirname(pkg), platformPkg)),
      vendor(pkg),
    ];
    return candidates.find((c) => exists(c)) ?? '';
  };
  // The setting, as given: absolute, there. The npm launcher (what `which codex` says after an
  // npm install) needs node on the PATH, as found on the PATH below: its native binary.
  if (configured) {
    if (!p.isAbsolute(configured) || !exists(configured)) return '';
    const real = realpath(configured);
    return real.endsWith('.js') ? native(p.dirname(p.dirname(real))) : configured;
  }
  for (const dir of o.pathEnv.split(windows ? ';' : ':')) {
    if (!dir || !p.isAbsolute(dir)) continue;
    if (windows) {
      if (exists(p.join(dir, exe))) return p.join(dir, exe);
      if (exists(p.join(dir, 'codex.cmd'))) {
        const found = native(p.join(dir, 'node_modules', '@openai', 'codex'));
        if (found) return found;
      }
      continue;
    }
    const onPath = p.join(dir, exe);
    if (!exists(onPath)) continue;
    const real = realpath(onPath);
    // The npm launcher (…/@openai/codex/bin/codex.js): its package's native binary.
    if (real.endsWith('.js')) {
      const found = native(p.dirname(p.dirname(real)));
      if (found) return found;
      continue;
    }
    return onPath;
  }
  return '';
}
