import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionApi } from '../../src/extension';
import { UNCHANGED } from '../../src/controller';
import { ReviewStore } from '../../src/review/store';
import { createFixtureRepo, type FixtureRepo } from '../fixtures/fixtureRepo';
import { activate, freshBranch, run, until, workspace } from './helpers';

describe('reviews kept apart', () => {
  let api: ExtensionApi;
  let other: FixtureRepo;

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-integrity');
    other = createFixtureRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-other-')));
  });

  after(async () => {
    await api.controller.start({ cwd: workspace(), base: 'main', open: false });
    fs.rmSync(other.dir, { recursive: true, force: true });
  });

  it("never carries another repository's notes or PR over to a branch of the same name", async () => {
    assert.ok(await api.controller.start({ cwd: workspace(), base: 'main', open: false }));
    api.controller.mutate((r) => {
      r.annotations.push({
        id: 'mine',
        file: 'src/auth/session.ts',
        side: 'new',
        startLine: 8,
        endLine: 8,
        anchorText: 'if (isExpired(token)) {',
        kind: 'how',
        title: 'A note of this repository',
        body: '',
      });
      r.github = {
        host: 'github.com',
        owner: 'acme',
        repo: 'my-app',
        number: 7,
        url: 'https://github.com/acme/my-app/pull/7',
        headSha: r.head.sha,
        baseRef: 'main',
      };
    });
    await until('the note', () => api.controller.resolved.some((a) => a.id === 'mine'));

    // Another repository, on a branch of the same name against a base of the same name, with
    // no review of its own yet.
    other.git('switch', '-q', '-c', 'it-integrity');
    assert.ok(await api.controller.start({ cwd: other.dir, base: 'main', open: false }));
    const t = api.controller.target!;
    assert.strictEqual(fs.realpathSync(t.root), fs.realpathSync(other.dir));
    const stored = new ReviewStore(t.gitDir).load(t.head.sha);
    assert.strictEqual(stored.kind, 'ok');
    assert.deepStrictEqual(stored.review.annotations, []);
    assert.strictEqual(stored.review.github, undefined);
    assert.ok(!api.controller.resolved.some((a) => a.id === 'mine'));
  });

  it('saves nothing for a change that changed nothing', async () => {
    assert.ok(await api.controller.start({ cwd: workspace(), base: 'main', open: false }));
    const file = api.controller.store!.reviewPath(api.controller.target!.head.sha);
    const before = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(api.controller.mutate(() => UNCHANGED));
    assert.strictEqual(fs.statSync(file).mtimeMs, before);
  });

  /** A note on the first line of src/auth/session.ts (its anchor is found on any head). */
  const note = (id: string) => ({
    id,
    file: 'src/auth/session.ts',
    side: 'new' as const,
    startLine: 1,
    endLine: 1,
    anchorText: run('show', 'HEAD:src/auth/session.ts').split('\n')[0],
    kind: 'how' as const,
    title: id,
    body: '',
  });
  const ids = () => api.controller.resolved.map((a) => a.id).sort();
  const onHead = (sha: string) =>
    until(`on ${sha.slice(0, 7)}`, () => api.controller.target?.head.sha === sha, 15000);

  it('keeps the notes written since when the branch goes back to a head reviewed before', async () => {
    await freshBranch(api, 'it-undo');
    assert.ok(await api.controller.start({ cwd: workspace(), base: 'main', open: false }));
    const a = run('rev-parse', 'HEAD');
    api.controller.mutate((r) => {
      r.annotations.push(note('on-a'));
    });
    await until('on-a', () => ids().includes('on-a'));
    run('commit', '-q', '--allow-empty', '-m', 'b');
    const b = run('rev-parse', 'HEAD');
    await onHead(b);
    api.controller.mutate((r) => {
      r.annotations.push(note('on-b'));
    });
    await until('on-b', () => ids().includes('on-b'));
    // Undo Last Commit: back on a head that has a review file of its own, an older one.
    run('reset', '-q', '--soft', a);
    await onHead(a);
    await until('the notes written since kept', () => ids().join() === 'on-a,on-b');
  });

  it('brings the notes back after a rebase, which goes through a detached HEAD', async () => {
    await freshBranch(api, 'it-rebase');
    assert.ok(await api.controller.start({ cwd: workspace(), base: 'main', open: false }));
    api.controller.mutate((r) => {
      r.annotations.push(note('before-rebase'));
    });
    await until('noted', () => ids().includes('before-rebase'));
    const before = run('rev-parse', 'HEAD');
    // As a rebase does: HEAD detached while commits are replayed, then the branch moved to
    // the new commits.
    run('checkout', '-q', '--detach');
    run('commit', '-q', '--allow-empty', '-m', 'replayed');
    const replayed = run('rev-parse', 'HEAD');
    await onHead(replayed);
    assert.notStrictEqual(replayed, before);
    run('checkout', '-q', '-B', 'it-rebase', replayed);
    await until('back on the branch', () => api.controller.target?.head.ref === 'it-rebase', 15000);
    await until('the notes back', () => ids().includes('before-rebase'));
  });

  it('keeps the notes written since when a change is recorded at the head before (a post)', async () => {
    await freshBranch(api, 'it-pinned');
    assert.ok(await api.controller.start({ cwd: workspace(), base: 'main', open: false }));
    const t = api.controller.target!;
    const h1 = { gitDir: t.gitDir, headSha: t.head.sha };
    api.controller.mutate((r) => {
      r.annotations.push(note('n1'));
    });
    await until('n1', () => ids().includes('n1'));
    run('commit', '-q', '--allow-empty', '-m', 'h2');
    const h2 = run('rev-parse', 'HEAD');
    await onHead(h2);
    api.controller.mutate((r) => {
      r.annotations.push(note('n2'));
    });
    await until('n2', () => ids().includes('n2'));
    // A post started at H1 ends now: recorded there (its file is the newest of the branch).
    api.controller.mutateAt(h1, (r) => {
      r.annotations.find((a) => a.id === 'n1')!.title = 'posted';
    });
    // The head open now carried n1: it is marked too.
    await until('marked at H2 too', () => api.controller.annotation('n1')?.title === 'posted');
    // Opened again on H2: its notes stay, not H1's older set.
    assert.ok(await api.controller.start({ cwd: workspace(), base: 'main', open: false }));
    await until('H2 keeps n1 and n2', () => ids().join() === 'n1,n2');
  });

  it("does not give a branch made again under an old name the old branch's notes", async () => {
    await freshBranch(api, 'it-reused');
    assert.ok(await api.controller.start({ cwd: workspace(), base: 'main', open: false }));
    api.controller.mutate((r) => {
      r.annotations.push(note('old-note'));
    });
    await until('old-note', () => ids().includes('old-note'));
    // Merged and deleted, long ago; a new branch of the same name later.
    run('switch', '-q', '--detach');
    run('branch', '-D', 'it-reused');
    run('switch', '-q', '-c', 'it-reused', 'main');
    run('commit', '-q', '--allow-empty', '-m', 'new work');
    const fresh = run('rev-parse', 'HEAD');
    await onHead(fresh);
    await until('on the new branch', () => api.controller.target?.head.ref === 'it-reused');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!ids().includes('old-note'), `old notes taken: ${ids().join()}`);
  });

  it('stays closed when closed while it was starting', async () => {
    const starting = api.controller.start({ cwd: workspace(), base: 'main', open: false });
    api.controller.close();
    assert.strictEqual(await starting, false);
    assert.strictEqual(api.controller.target, undefined);
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(api.controller.target, undefined, 'not set up again later');
  });
});
