import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The fixture builder is compiled by `pretest:integration` into out/.
const require = createRequire(import.meta.url);
const { createFixtureRepo } = require('./out/test/fixtures/fixtureRepo.js');
const workspace = createFixtureRepo(mkdtempSync(join(tmpdir(), 'review-desk-it-'))).dir;
const fakeClaudeLog = join(mkdtempSync(join(tmpdir(), 'review-desk-fake-')), 'calls.jsonl');
// Claude Code's config (MCP registrations) for the run, so tests never touch ~/.claude.json.
const claudeConfigDir = mkdtempSync(join(tmpdir(), 'review-desk-claude-'));

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: workspace,
  launchArgs: ['--disable-extensions'],
  env: { FAKE_CLAUDE_LOG: fakeClaudeLog, CLAUDE_CONFIG_DIR: claudeConfigDir },
  mocha: { ui: 'bdd', timeout: 20000 },
});
