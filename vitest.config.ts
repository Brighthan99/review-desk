import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// On macOS /usr/bin/git is an xcrun shim; many parallel calls through it get very slow.
// Put the real binary first on PATH for the test run (globalSetup and workers inherit it).
if (process.platform === 'darwin') {
  try {
    const real = execFileSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim();
    process.env.PATH = `${path.dirname(real)}${path.delimiter}${process.env.PATH}`;
  } catch {
    // No Xcode tools: keep PATH as it is.
  }
}

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    globalSetup: ['test/unit/globalSetup.ts'],
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
