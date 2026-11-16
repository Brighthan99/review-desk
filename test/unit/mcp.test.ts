import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadReview,
  MAX_NOTES_CHARS,
  noteDetails,
  reviewIndex,
  type LoadedReview,
} from '../../src/mcp/reviewNotes';
import { saveNote } from '../../src/mcp/saveNote';
import { serve, type Tool } from '../../src/mcp/server';
import type { Annotation, Review } from '../../src/review/model';
import { ReviewStore } from '../../src/review/store';
import { computeTarget, diffDigest } from '../../src/review/target';
import type { FixtureRepo } from '../fixtures/fixtureRepo';
import { fixtureCopy, removeFixture } from './helpers';

/** Sends `requests` (one per line) to a server and returns its answers by id. */
async function talk(tools: Tool[], requests: (object | string)[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d: Buffer) => (out += d.toString()));
  const done = serve({ name: 'test', version: '1', instructions: 'Use it.' }, tools, input, output);
  input.end(requests.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  await done;
  const answers = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return new Map(answers.map((a) => [a.id, a]));
}

describe('MCP server', () => {
  const echo: Tool = {
    name: 'echo',
    description: 'Echoes',
    inputSchema: { type: 'object' },
    call: async (args) => {
      if (args.fail) throw new Error('no review');
      return `said ${String(args.text)}`;
    },
  };

  it('answers initialize with the asked version, its tools and instructions', async () => {
    const answers = await talk(
      [echo],
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
        { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        { jsonrpc: '2.0', id: 4, method: 'ping' },
      ],
    );
    expect(answers.get(1).result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'test' },
      instructions: 'Use it.',
    });
    expect(answers.get(2).result.protocolVersion).toBe('2025-11-25');
    expect(answers.get(3).result.tools).toEqual([
      { name: 'echo', description: 'Echoes', inputSchema: { type: 'object' } },
    ]);
    expect(answers.get(4).result).toEqual({});
    expect(answers.size).toBe(4);
  });

  it('calls tools and reports their failures and unknown requests', async () => {
    const call = (id: number, name: string, args: object) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const answers = await talk(
      [echo],
      [
        call(1, 'echo', { text: 'hi' }),
        call(2, 'echo', { fail: true }),
        call(3, 'nope', {}),
        { jsonrpc: '2.0', id: 4, method: 'resources/list' },
        '{not json',
      ],
    );
    expect(answers.get(1).result).toEqual({ content: [{ type: 'text', text: 'said hi' }] });
    expect(answers.get(2).result).toEqual({
      content: [{ type: 'text', text: 'no review' }],
      isError: true,
    });
    expect(answers.get(3).error.code).toBe(-32602);
    expect(answers.get(4).error.code).toBe(-32601);
    expect(answers.get(null).error.code).toBe(-32700);
  });
});

describe('review notes for the chat', () => {
  let repo: FixtureRepo;
  let store: ReviewStore;
  const head = () => repo.git('rev-parse', 'HEAD').trim();

  const note = (a: Partial<Annotation> & { id: string }): Annotation => ({
    file: 'src/auth/session.ts',
    side: 'new',
    startLine: 8,
    endLine: 13,
    anchorText: '  if (isExpired(token)) {',
    kind: 'risk',
    title: 'May refresh twice at once',
    body: 'Two requests both call `refresh`.',
    ...a,
  });

  async function save(annotations: Annotation[], extra: Partial<Review> = {}): Promise<void> {
    const t = await computeTarget(repo.dir, 'main', { workTree: true });
    store.save({
      version: 1,
      base: t.base,
      head: t.head,
      workTree: true,
      status: 'done',
      annotations,
      ...extra,
    });
  }

  async function load(): Promise<LoadedReview> {
    const l = await loadReview(path.join(repo.dir, 'src'));
    if (typeof l === 'string') throw new Error(l);
    return l;
  }

  beforeAll(() => {
    repo = fixtureCopy();
    store = new ReviewStore(path.join(repo.dir, '.git'));
  });
  afterAll(() => removeFixture(repo));

  it('says when there is no review of the branch', async () => {
    expect(await loadReview(repo.dir)).toMatch(/no Review Desk review of the current branch/);
  });

  it('indexes the summary and the notes by file, with lines matched to the code', async () => {
    const t = await computeTarget(repo.dir, 'main', { workTree: true });
    await save(
      [
        note({ id: 'a1', startLine: 7, endLine: 12, thread: [] }),
        note({
          id: 'f1',
          startLine: 0,
          endLine: 0,
          anchorText: 'old digest',
          kind: 'overview',
          title: 'Refreshes expired tokens',
        }),
        note({
          id: 'q1',
          file: '',
          startLine: 0,
          endLine: 0,
          anchorText: '',
          kind: 'question',
          title: 'Why on the server?',
          thread: [{ from: 'user', body: 'Why on the server?', at: '2026-01-01T00:00:00Z' }],
        }),
        note({
          id: 'p1',
          file: 'src/lib/api-client.ts',
          title: 'Writing…',
          body: '',
          pending: true,
        }),
      ],
      { overview: 'Tokens refresh on the server.', overviewOf: diffDigest(t) },
    );
    const index = reviewIndex(await load());
    expect(index).toContain('# Review Desk: feat/refresh against main');
    expect(index).toContain(`Repository: ${t.root} (note paths are relative to it).`);
    expect(index).toContain(`The change is \`git diff ${t.base.sha.slice(0, 7)}\``);
    expect(index).toContain('## Summary of the change\nTokens refresh on the server.');
    expect(index).not.toContain('Out of date');
    expect(index).toContain(
      [
        '### src/auth/session.ts',
        '- [Overview] whole file: Refreshes expired tokens (outdated: the file has changed since, id f1)',
        '- [Risk] lines 8-13: May refresh twice at once (id a1)',
      ].join('\n'),
    );
    expect(index).toContain('- [Risk] lines 8-13: Writing… (still being written, id p1)');
    // Questions about the whole change come after the files.
    expect(index.trimEnd()).toMatch(
      /### Questions about the whole change\n- \[Question\] Why on the server\? \(1 follow-up question, id q1\)$/,
    );
  });

  it('marks a summary written for another state of the change', async () => {
    await save([], { overview: 'Old summary.', overviewOf: 'something else' });
    expect(reviewIndex(await load())).toContain(
      '_Out of date: written for an earlier state of the change._\n\nOld summary.',
    );
  });

  it('gives the full notes on a file or by id, with their follow-up questions', async () => {
    await save([
      note({
        id: 'a1',
        thread: [
          {
            from: 'user',
            body: 'Does a lock help?',
            at: '2026-01-01T00:00:00Z',
            selection: { file: 'src/auth/session.ts', startLine: 9, endLine: 9 },
          },
          { from: 'ai', body: 'Yes.', at: '2026-01-01T00:00:01Z' },
          { from: 'user', author: 'octocat', body: 'Agreed.', at: '2026-01-01T00:00:02Z' },
        ],
      }),
      note({ id: 'b1', file: 'src/lib/api-client.ts', startLine: 1, endLine: 1, side: 'old' }),
    ]);
    const l = await load();
    const onFile = noteDetails(l, { file: 'session.ts' });
    expect(onFile).toContain(
      '## [Risk] May refresh twice at once\nsrc/auth/session.ts, lines 8-13 · id a1\n\nTwo requests both call `refresh`.',
    );
    expect(onFile).toContain('**Reviewer** (about line 9):\nDoes a lock help?');
    expect(onFile).toContain('**Review Desk**:\nYes.');
    expect(onFile).toContain('**octocat (GitHub)**:\nAgreed.');
    expect(onFile).not.toContain('id b1');

    const byId = noteDetails(l, { ids: ['b1', 'zz'] });
    expect(byId).toContain('src/lib/api-client.ts, line 1 of the base version');
    expect(byId).toContain('No notes with ids zz.');
    expect(noteDetails(l, { file: 'nope.ts' })).toBe(
      'No notes on nope.ts. Files with notes: src/auth/session.ts, src/lib/api-client.ts.',
    );
    expect(noteDetails(l, {})).toContain('id b1');
  });

  it('leaves out notes past the length limit and names them', async () => {
    // Two fit with their headings, a third does not.
    const long = 'x'.repeat(MAX_NOTES_CHARS / 2 - 200);
    await save(['n1', 'n2', 'n3'].map((id) => note({ id, body: long })));
    const text = noteDetails(await load(), {});
    expect(text).toContain('id n2');
    expect(text).not.toContain('id n3');
    expect(text).toContain('1 more note left out for length: n3. Ask for them by id.');
  });

  it('falls back to the branch review of an earlier commit after HEAD moved', async () => {
    await save([note({ id: 'a1' })]);
    const before = head();
    fs.writeFileSync(path.join(repo.dir, 'NOTES.md'), 'moved\n');
    repo.git('add', 'NOTES.md');
    repo.git('commit', '-q', '-m', 'move head');
    const l = await load();
    expect(l.earlierHead).toBe(before);
    expect(reviewIndex(l)).toContain(
      `The notes were written at an earlier commit of the branch (${before.slice(0, 7)})`,
    );
    expect(l.notes[0]).toMatchObject({ id: 'a1', state: 'ok', resolvedStart: 8 });
  });
});

describe('saving chat answers into the review', () => {
  let repo: FixtureRepo;
  let store: ReviewStore;
  const now = new Date('2026-11-06T00:00:00Z');
  const at = now.toISOString();
  const stored = () => {
    const r = store.load(repo.git('rev-parse', 'HEAD').trim());
    if (r.kind !== 'ok') throw new Error('no review');
    return r.review;
  };

  beforeAll(() => {
    repo = fixtureCopy();
    store = new ReviewStore(path.join(repo.dir, '.git'));
  });
  afterAll(() => removeFixture(repo));

  it('needs a review of HEAD', async () => {
    await expect(
      saveNote(repo.dir, { file: 'src/auth/session.ts', startLine: 8, body: 'x' }),
    ).rejects.toThrow(/no Review Desk review/);
  });

  it('saves an explanation as a note on the lines', async () => {
    const t = await computeTarget(repo.dir, 'main', { workTree: true });
    store.save({
      version: 1,
      base: t.base,
      head: t.head,
      workTree: true,
      status: 'done',
      annotations: [],
    });
    const text = await saveNote(
      repo.dir,
      {
        file: path.join(repo.dir, 'src/auth/session.ts'),
        startLine: 8,
        endLine: 13,
        kind: 'risk',
        title: 'Refresh inside the request',
        body: 'It refreshes.',
      },
      now,
    );
    const [a] = stored().annotations;
    expect(a).toMatchObject({
      file: 'src/auth/session.ts',
      side: 'new',
      startLine: 8,
      endLine: 13,
      anchorText: '  if (isExpired(token)) {',
      kind: 'risk',
      title: 'Refresh inside the request',
      body: 'It refreshes.',
      group: 'src/auth/session.ts',
      origin: 'chat',
      order: 1,
    });
    expect(a.thread).toBeUndefined();
    expect(text).toBe(
      `Saved in Review Desk as a note on src/auth/session.ts, lines 8-13 (id ${a.id}). It shows in the Review Desk panel.`,
    );
  });

  it('adds an answer on the same lines to the note already there', async () => {
    const text = await saveNote(
      repo.dir,
      {
        file: 'src/auth/session.ts',
        startLine: 8,
        endLine: 13,
        question: 'Two at once?',
        body: 'Yes.',
      },
      now,
    );
    const notes = stored().annotations;
    expect(notes).toHaveLength(1);
    expect(notes[0].thread).toEqual([
      { from: 'user', body: 'Two at once?', at, origin: 'chat' },
      { from: 'ai', body: 'Yes.', at, origin: 'chat' },
    ]);
    expect(text).toMatch(
      /Added to the conversation of the Review Desk note "Refresh inside the request"/,
    );
  });

  it('keeps a question on other lines as a question card, and takes follow-ups by id', async () => {
    await saveNote(
      repo.dir,
      {
        file: './src/auth/session.ts',
        startLine: 9,
        question: 'Why await here?',
        body: 'Because.',
      },
      now,
    );
    const q = stored().annotations.at(-1)!;
    expect(q).toMatchObject({
      kind: 'question',
      title: 'Why await here?',
      body: '',
      group: 'Questions',
      startLine: 9,
      endLine: 9,
      order: 2,
      origin: 'chat',
    });
    expect(q.thread?.map((m) => [m.from, m.body])).toEqual([
      ['user', 'Why await here?'],
      ['ai', 'Because.'],
    ]);
    await saveNote(repo.dir, { id: q.id, body: 'More.' }, now);
    expect(stored().annotations.at(-1)!.thread?.slice(2)).toEqual([
      { from: 'user', body: 'Explained in the Claude Code chat.', at, origin: 'chat' },
      { from: 'ai', body: 'More.', at, origin: 'chat' },
    ]);
  });

  it('saves a PR comment as a card of its own, even where a note is on the same lines', async () => {
    const before = stored().annotations.length;
    const text = await saveNote(
      repo.dir,
      {
        file: 'src/auth/session.ts',
        startLine: 8,
        endLine: 13,
        kind: 'comment',
        body: '**issue:** Two requests refresh at once\n\nGuard the refresh.',
      },
      now,
    );
    const all = stored().annotations;
    expect(all.length).toBe(before + 1);
    expect(all.at(-1)).toMatchObject({
      kind: 'comment',
      title: 'Two requests refresh at once',
      body: '**issue:** Two requests refresh at once\n\nGuard the refresh.',
      startLine: 8,
      endLine: 13,
      origin: 'chat',
    });
    expect(text).toMatch(
      /^Saved in Review Desk as a PR comment \(the user can edit it and post it/,
    );
  });

  it('refuses what it cannot place', async () => {
    const fails = (req: Parameters<typeof saveNote>[1], message: RegExp) =>
      expect(saveNote(repo.dir, req)).rejects.toThrow(message);
    await fails({ body: ' ' }, /`body` is empty/);
    await fails({ body: 'x' }, /Give the `file`/);
    await fails({ file: '../outside.ts', startLine: 1, body: 'x' }, /Give the `file`/);
    await fails({ file: 'src/../../outside.ts', startLine: 1, body: 'x' }, /Give the `file`/);
    // Not a whole line number: refused, not saved (the file would no longer read back).
    await fails(
      { file: 'src/auth/session.ts', startLine: 1, endLine: 2.5, body: 'x' },
      /not a range/,
    );
    await fails({ file: 'nope.ts', startLine: 1, body: 'x' }, /No file nope\.ts/);
    await fails({ file: 'src/auth/session.ts', startLine: 900, body: 'x' }, /has lines 1-/);
    await fails({ id: 'zz', body: 'x' }, /No note with id zz/);
  });

  it('titles a note whose first line is only a heading mark, so the review still reads', async () => {
    await saveNote(repo.dir, {
      file: 'src/auth/session.ts',
      startLine: 2,
      body: '##\n\nThe body.',
    });
    const saved = stored().annotations.find((a) => a.body === '##\n\nThe body.')!;
    expect(saved.title).toBe('The body.');
  });
});
