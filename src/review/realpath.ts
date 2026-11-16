import * as fs from 'node:fs';

/** `p` with symlinks resolved (/var is /private/var on macOS); `p` itself when it is not there. */
export function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Whether two paths are the same folder, one perhaps through a symlink. */
export function samePath(a: string, b: string): boolean {
  return realpath(a) === realpath(b);
}
