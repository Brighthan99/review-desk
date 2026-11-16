// What a language setting may say. No vscode import, so tests use it.

/**
 * A language name as the prompts may say it: letters (any script), spaces and a few marks,
 * short. Anything else is not a language name but text a repository's settings could slip
 * into every prompt, so it is not used.
 */
export function languageName(value: string): string | undefined {
  const v = value.trim();
  return v && v.length <= 40 && /^[\p{L}\p{M}][\p{L}\p{M} ()'-]*$/u.test(v) ? v : undefined;
}
