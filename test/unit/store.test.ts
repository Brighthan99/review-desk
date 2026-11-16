import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Review } from '../../src/review/model';
import { commonGitDir, ReviewStore, storeDir, watchFile } from '../../src/review/store';

const REVIEW: Review = {
  version: 1,
  base: { ref: 'main', sha: 'b'.repeat(40) },
  head: { ref: 'feat', sha: 'h'.repeat(40) },
  status: 'done',
  annotations: [
    {
      id: 'a1',
      file: 'x.ts',
      side: 'new',
      startLine: 1,
      endLine: 2,
      anchorText: 'x',
      kind: 'why',
      title: 'title',
      body: 'body',
    },
  ],
};

describe('ReviewStore', () => {
  let gitDir: string;
  let store: ReviewStore;

  beforeEach(() => {
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-store-'));
    store = new ReviewStore(gitDir);
  });
  afterEach(() => fs.rmSync(gitDir, { recursive: true, force: true }));

  it('saves under <git-dir>/review-desk and loads it back', () => {
    store.save(REVIEW);
    expect(fs.existsSync(path.join(gitDir, 'review-desk', `${'h'.repeat(40)}.json`))).toBe(true);
    expect(store.load('h'.repeat(40))).toEqual({ kind: 'ok', review: REVIEW });
  });

  it('reports missing and invalid files', () => {
    expect(store.load('nope')).toEqual({ kind: 'missing' });
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.reviewPath('broken'), '{ not json');
    expect(store.load('broken')).toMatchObject({ kind: 'invalid' });
    fs.writeFileSync(store.reviewPath('wrong'), JSON.stringify({ ...REVIEW, version: 2 }));
    const r = store.load('wrong');
    expect(r.kind).toBe('invalid');
    expect(r.kind === 'invalid' && r.error).toMatch(/version/);
  });

  it('fills defaults the agent may leave out', () => {
    fs.mkdirSync(store.dir, { recursive: true });
    const { status: _s, ...rest } = REVIEW;
    const minimal = {
      ...rest,
      annotations: [{ ...REVIEW.annotations[0], side: undefined, body: undefined }],
    };
    fs.writeFileSync(store.reviewPath('min'), JSON.stringify(minimal));
    const r = store.load('min');
    expect(r.kind === 'ok' && r.review.status).toBe('writing');
    expect(r.kind === 'ok' && r.review.annotations[0]).toMatchObject({ side: 'new', body: '' });
  });

  it('notifies when someone else writes the review file, not for its own saves', async () => {
    let calls = 0;
    const w = store.watch('h'.repeat(40), () => calls++);
    try {
      // Its own save is reloaded by whoever saved; the watcher stays quiet.
      store.save(REVIEW);
      await new Promise((r) => setTimeout(r, 1500));
      expect(calls).toBe(0);
      // Another writer (the chat's MCP server, another window) is heard.
      new ReviewStore(gitDir).save({ ...REVIEW, status: 'writing' });
      const end = Date.now() + 5000;
      while (!calls && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(calls).toBeGreaterThan(0);
    } finally {
      w.dispose();
    }
  });

  it('moves the reviews kept under the earlier name', () => {
    const legacy = path.join(gitDir, 'erudite');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, `${'h'.repeat(40)}.json`), JSON.stringify(REVIEW));
    expect(storeDir(gitDir)).toBe(path.join(gitDir, 'review-desk'));
    expect(fs.existsSync(legacy)).toBe(false);
    expect(new ReviewStore(gitDir).load('h'.repeat(40)).kind).toBe('ok');
  });
});

describe('one review folder for all worktrees', () => {
  let common: string;
  let own: string;

  beforeEach(() => {
    // A main git dir and a linked worktree's own one, as git lays them out.
    common = fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-common-'));
    own = path.join(common, 'worktrees', 'wt');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'commondir'), '../..\n');
  });
  afterEach(() => fs.rmSync(common, { recursive: true, force: true }));

  it('finds the shared git dir of a worktree', () => {
    expect(commonGitDir(own)).toBe(common);
    expect(commonGitDir(common)).toBe(common);
  });

  it('keeps reviews in the shared git dir, moving those a worktree kept on its own', () => {
    const old = path.join(own, 'review-desk');
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'aaa.json'), '{}');
    const dir = storeDir(own);
    expect(dir).toBe(path.join(common, 'review-desk'));
    expect(fs.existsSync(path.join(dir, 'aaa.json'))).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    new ReviewStore(own).save(REVIEW);
    expect(fs.existsSync(path.join(dir, `${REVIEW.head.sha}.json`))).toBe(true);
  });
});

describe('watching a review file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-watch-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const changed = (count: () => number, at: number) =>
    new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = setInterval(() => {
        if (count() >= at) {
          clearInterval(check);
          resolve();
        } else if (Date.now() - start > 4000) {
          clearInterval(check);
          reject(new Error('no change seen'));
        }
      }, 50);
    });

  it('goes on by polling when watching cannot start (too many open files)', async () => {
    let changes = 0;
    const failing = (() => {
      throw Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });
    }) as unknown as typeof fs.watch;
    const w = watchFile(dir, 'x.json', () => changes++, failing);
    fs.writeFileSync(path.join(dir, 'x.json'), '{}');
    await changed(() => changes, 1);
    w.dispose();
  });

  it('goes on by polling when watching fails later, closing the watcher', async () => {
    let changes = 0;
    let closed = false;
    const watcher = Object.assign(new EventEmitter(), { close: () => (closed = true) });
    const w = watchFile(
      dir,
      'y.json',
      () => changes++,
      (() => watcher) as unknown as typeof fs.watch,
    );
    // No listener would make this an uncaught error.
    watcher.emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));
    assert.ok(closed);
    fs.writeFileSync(path.join(dir, 'y.json'), '{}');
    await changed(() => changes, 1);
    w.dispose();
  });
});

describe('saving a review that would not read back', () => {
  it('refuses to write it, keeping the file as it was', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-save-'));
    try {
      const store = new ReviewStore(dir);
      const good: Review = {
        version: 1,
        base: { ref: 'main', sha: 'a'.repeat(40) },
        head: { ref: 'x', sha: 'b'.repeat(40) },
        status: 'done',
        annotations: [],
      };
      store.save(good);
      const bad = structuredClone(good);
      bad.annotations.push({
        id: 'n1',
        file: 'a.ts',
        side: 'new',
        startLine: 1,
        endLine: 2.5,
        anchorText: '',
        kind: 'how',
        title: '',
        body: '',
      });
      expect(() => store.save(bad)).toThrow(/would not read back/);
      expect(store.load('b'.repeat(40))).toMatchObject({ kind: 'ok' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
