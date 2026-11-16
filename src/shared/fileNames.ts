/**
 * The files of `files` that `name` names: itself when listed, else those whose path ends with
 * `/name`. The AI often writes `session.ts` or `auth/session.ts` for `src/auth/session.ts`.
 * Shared by the extension and the panel.
 */
export function filesNamed(name: string, files: readonly string[]): string[] {
  const n = name.replace(/^\.\//, '');
  return files.includes(n) ? [n] : files.filter((f) => f.endsWith(`/${n}`));
}

/** The one file of `files` that `name` names, if exactly one does. */
export function fileNamed(name: string, files: readonly string[]): string | undefined {
  const found = filesNamed(name, files);
  return found.length === 1 ? found[0] : undefined;
}
