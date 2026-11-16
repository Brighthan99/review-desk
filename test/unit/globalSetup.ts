import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFixtureRepo } from '../fixtures/fixtureRepo';

declare module 'vitest' {
  export interface ProvidedContext {
    fixtureTemplate: string;
  }
}

// Builds the fixture repository once per run; tests copy it with fixtureCopy().
export default function setup(project: { provide(key: 'fixtureTemplate', value: string): void }) {
  const dir = createFixtureRepo(
    fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-template-')),
  ).dir;
  project.provide('fixtureTemplate', dir);
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
