// The Review Desk MCP server: lets the Claude Code chat read the notes of the review open in
// Review Desk. Claude Code starts it per chat (registered by "Review Desk: Connect Claude Code Chat")
// as `<vscode binary> mcp.js --repo <root> [--git <git>]` with ELECTRON_RUN_AS_NODE=1.
import { setGitPath } from '../review/git';
import { serve } from './server';
import { INSTRUCTIONS, reviewTools } from './tools';

declare const REVIEW_DESK_VERSION: string;

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const gitPath = option('--git');
if (gitPath) setGitPath(gitPath);
void serve(
  { name: 'review-desk', version: REVIEW_DESK_VERSION, instructions: INSTRUCTIONS },
  reviewTools(option('--repo') ?? process.cwd()),
  process.stdin,
  process.stdout,
).then(() => process.exit(0));
