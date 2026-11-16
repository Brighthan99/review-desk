#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` in tests. Logs its arguments and
// prompt to $FAKE_CLAUDE_LOG and streams a canned answer. The prompt steers it:
//   [slow]  pause between chunks (for cancel tests; also when $FAKE_CLAUDE_SLOW is set)
//   [fail]  end with an error result (also when $FAKE_CLAUDE_FAIL is set)
// A translation request gets its texts back as a JSON array, each marked `(Language) `.
// It reports a context of $FAKE_CLAUDE_TOKENS tokens (default 1000) for the session.
// An explanation request gets an answer in the `[kind] title` format (a file summary one in
// `[overview] title`), a summary request a short summary with file references.
// `claude mcp add-json|remove <name> … -s local` keep a registration in
// $CLAUDE_CONFIG_DIR/.claude.json under the git root of the working directory (else the
// directory itself), as claude does.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
// `claude auth status --json`: signed in to a Claude Max plan, unless $FAKE_CLAUDE_AUTH_STATUS says
// `apikey` or `none` (signed out).
if (args[0] === 'auth' && args[1] === 'status') {
  const auth = process.env.FAKE_CLAUDE_AUTH_STATUS;
  console.log(
    JSON.stringify(
      auth === 'none'
        ? { loggedIn: false }
        : auth === 'apikey'
          ? { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }
          : {
              loggedIn: true,
              authMethod: 'claude.ai',
              apiProvider: 'firstParty',
              email: 'reviewer@example.com',
              subscriptionType: 'max',
            },
    ),
  );
  process.exit(0);
}
if (args[0] === 'mcp') {
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt: '' }) + '\n');
  }
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    root = process.cwd();
  }
  root = fs.realpathSync(root);
  const servers = (((config.projects ??= {})[root] ??= {}).mcpServers ??= {});
  const name = args[2];
  if (args[1] === 'add-json') {
    if (servers[name]) {
      console.error(`MCP server ${name} already exists in local config`);
      process.exit(1);
    }
    servers[name] = JSON.parse(args[3]);
  } else if (args[1] === 'remove') {
    if (!servers[name]) {
      console.error(`No MCP server named "${name}" in local scope`);
      process.exit(1);
    }
    delete servers[name];
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt }) + '\n');
  }
  const resume = args.indexOf('--resume');
  const fork = args.includes('--fork-session');
  const session =
    resume >= 0 && !fork
      ? args[resume + 1]
      : `fork-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: session }) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  out({ type: 'system', subtype: 'init', apiKeySource: process.env.FAKE_CLAUDE_AUTH ?? 'none' });
  if (prompt.includes('[fail]') || process.env.FAKE_CLAUDE_FAIL) {
    out({ type: 'result', subtype: 'error_max_budget_usd', is_error: true });
    return;
  }
  const answer =
    process.env.FAKE_CLAUDE_ANSWER ??
    (prompt.startsWith('[Review Desk: explain]')
      ? '[risk] May refresh twice at once\n\nAn expired token is refreshed inside the request. Two requests at the same time both call `refresh`.'
      : prompt.startsWith('[Review Desk: reply]')
        ? 'Thanks — that fixes it.'
        : prompt.startsWith('[Review Desk: comment]')
          ? prompt.includes('Rewrite it as the reviewer asks')
            ? '**nitpick:** Guard the refresh\n\nShorter now.'
            : '**issue:** May refresh twice at once\n\nTwo requests can both call `refresh`. Guard it.\n\n```suggestion\n  if (isExpired(token) && !refreshing) {\n```'
          : prompt.startsWith('[Review Desk: file summary]')
            ? '[overview] Refreshes expired tokens in place\n\nThe session refreshes an expired token instead of failing.\n\n- Refresh on expiry (`src/auth/session.ts:9`)'
            : prompt.startsWith('[Review Desk: summary]')
              ? 'Expired tokens are now refreshed on the server.\n\n### Changes\n- **Auth** — refreshes an expired token in place (`src/auth/session.ts`)\n\n### Worth a closer look\n- Two requests may refresh at once (`src/auth/session.ts:9`)'
              : prompt.startsWith('[Review Desk: translate]')
                ? JSON.stringify(
                    JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).map(
                      (t) => `(${/into (.+?)\. They are/.exec(prompt)[1]}) ${t}`,
                    ),
                  )
                : 'Yes. Each request calls `refresh` on its own.');
  out({ type: 'stream_event', event: { type: 'message_start' } });
  for (const piece of answer.match(/.{1,6}/gsu) ?? []) {
    out({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } },
    });
    await sleep(prompt.includes('[slow]') || process.env.FAKE_CLAUDE_SLOW ? 300 : 5);
  }
  const tokens = Number(process.env.FAKE_CLAUDE_TOKENS ?? 1000);
  out({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: answer }],
      usage: { input_tokens: 10, cache_creation_input_tokens: tokens - 30, output_tokens: 20 },
    },
  });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: answer,
    total_cost_usd: 0.001,
  });
});
