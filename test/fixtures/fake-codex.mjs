#!/usr/bin/env node
// Stand-in for `codex exec --json … -` in tests: logs its arguments and prompt to
// $FAKE_CLAUDE_LOG (marked agent "codex"), gets the answer fake-claude.mjs would give, and
// prints it as Codex's JSON events (thread.started, item.completed agent_message,
// turn.completed). `codex login status` says "Logged in using ChatGPT" on stderr, or, with
// $FAKE_CODEX_AUTH=apikey, an API key. The thread is the one resumed or forked, else new.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_CODEX_AUTH === 'none') {
    console.error('Not logged in');
    process.exit(1);
  }
  console.error(
    process.env.FAKE_CODEX_AUTH === 'apikey'
      ? 'API key configured - sk-***test'
      : 'Logged in using ChatGPT',
  );
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(
      process.env.FAKE_CLAUDE_LOG,
      JSON.stringify({ agent: 'codex', args, prompt }) + '\n',
    );
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const resume = args.indexOf('resume');
  const thread =
    resume >= 0
      ? args[resume + 1]
      : `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });
  // The answer fake-claude gives this prompt (not logged twice).
  const env = { ...process.env };
  delete env.FAKE_CLAUDE_LOG;
  const claude = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
  const r = spawnSync(process.execPath, [claude, '-p'], { input: prompt, env, encoding: 'utf8' });
  const result = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((m) => m.type === 'result');
  if (!result || result.is_error) {
    out({ type: 'turn.failed', error: { message: 'usage limit reached' } });
    process.exit(1);
  }
  out({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'Reading the code.' } });
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: result.result } });
  out({
    type: 'turn.completed',
    usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 100 },
  });
});
