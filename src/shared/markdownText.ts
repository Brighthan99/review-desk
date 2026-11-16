// Text put into VS Code markdown (hovers) as it is. No vscode import, so tests use it.

/** Text shown as it is in a hover's markdown: no link, emphasis or code of its own. */
export function markdownText(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

/** A fenced code block that the code itself cannot close: a fence longer than any run in it. */
export function fenced(code: string, language: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}
