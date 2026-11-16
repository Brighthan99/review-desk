import * as assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { servedRepo, type ServerConfig } from '../../src/ui/chatConnection';
import { activate, fakeCalls, freshBranch, run, until, useFakeClaude } from './helpers';

interface Answer {
  id: number;
  result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] };
}

/** Starts the server as Claude Code would, sends it `requests` and returns its answers by id. */
async function talk(config: ServerConfig, requests: object[]): Promise<Map<number, Answer>> {
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env } });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stdin.end(requests.map((r) => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n');
  await new Promise((resolve) => child.on('close', resolve));
  const answers = out
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Answer);
  return new Map(answers.map((a) => [a.id, a]));
}

const fakeClaude = () =>
  vscode.workspace.getConfiguration('reviewDesk').get<string>('claudePath') ?? '';

describe('Claude Code chat connection', () => {
  let api: ExtensionApi;
  const root = () => fs.realpathSync(run('rev-parse', '--show-toplevel'));

  before(async () => {
    api = await activate();
    await freshBranch(api, 'it-chat');
    await vscode.commands.executeCommand('reviewDesk.start', { base: 'main', open: false });
    await useFakeClaude(true);
  });

  after(async () => {
    await useFakeClaude(false);
  });

  it('registers the MCP server for the repository in Claude Code', async () => {
    assert.strictEqual(await vscode.commands.executeCommand('reviewDesk.connectChat'), true);
    const config = api.chat.registered(root())!;
    assert.ok(config, 'registered under the repository root');
    assert.strictEqual(config.command, process.execPath);
    assert.strictEqual(config.env?.ELECTRON_RUN_AS_NODE, '1');
    assert.ok(fs.existsSync(config.args[0]), 'the server script is copied out of the extension');
    assert.deepStrictEqual(config.args.slice(1, 3), ['--repo', root()]);
    const add = fakeCalls().find((c) => c.args[1] === 'add-json')!;
    assert.deepStrictEqual([add.args[2], ...add.args.slice(4)], ['review-desk', '-s', 'local']);

    // Connecting again replaces the registration instead of failing on the taken name.
    assert.strictEqual(await vscode.commands.executeCommand('reviewDesk.connectChat'), true);
    assert.ok(fakeCalls().some((c) => c.args[1] === 'remove'));
  });

  it('serves the review summary and the notes with their follow-up questions', async () => {
    api.controller.mutate((r) => {
      r.overview = 'Expired tokens are now refreshed on the server.';
      r.annotations.push({
        id: 'chat1',
        file: 'src/auth/session.ts',
        side: 'new',
        startLine: 8,
        endLine: 13,
        anchorText: '  if (isExpired(token)) {',
        kind: 'risk',
        title: 'May refresh twice at once',
        body: 'Two requests at the same time both call `refresh`.',
        thread: [
          { from: 'user', body: 'Does a lock help?', at: '2026-01-01T00:00:00Z' },
          { from: 'ai', body: 'Yes, a single-flight promise.', at: '2026-01-01T00:00:01Z' },
        ],
      });
    });
    await until('note loaded', () => api.controller.resolved.some((a) => a.id === 'chat1'));

    const answers = await talk(api.chat.registered(root())!, [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'review', arguments: {} } },
      { id: 4, method: 'tools/call', params: { name: 'notes', arguments: { file: 'session.ts' } } },
    ]);
    assert.deepStrictEqual(
      answers.get(2)!.result!.tools!.map((t) => t.name),
      ['review', 'notes', 'save_note'],
    );
    const review = answers.get(3)!.result!.content![0].text;
    assert.match(review, /# Review Desk: it-chat against main/);
    assert.match(review, /Expired tokens are now refreshed on the server\./);
    assert.match(
      review,
      /- \[Risk\] lines 8-13: May refresh twice at once \(1 follow-up question, id chat1\)/,
    );
    const notes = answers.get(4)!.result!.content![0].text;
    assert.match(notes, /src\/auth\/session\.ts, lines 8-13 · id chat1/);
    assert.match(notes, /both call `refresh`/);
    assert.match(notes, /\*\*Reviewer\*\*:\nDoes a lock help\?/);
    assert.match(notes, /\*\*Review Desk\*\*:\nYes, a single-flight promise\./);
  });

  it('saves an answer from the chat as a note and opens the panel on it', async () => {
    const answers = await talk(api.chat.registered(root())!, [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'save_note',
          arguments: {
            file: 'src/auth/session.ts',
            startLine: 2,
            endLine: 3,
            kind: 'context',
            title: 'Imports the token helpers',
            body: 'Brings in `isExpired` and `refresh`.',
          },
        },
      },
    ]);
    const saved = answers.get(2)!.result!;
    assert.ok(!saved.isError, saved.content![0].text);
    const id = /\(id (c\w+)\)/.exec(saved.content![0].text)![1];
    await until('the note in the review', () => api.controller.resolved.some((a) => a.id === id));
    await until('the panel on the note', () => api.panel.activeId === id);
    const card = api.controller.resolved.find((a) => a.id === id)!;
    assert.deepStrictEqual(
      [card.origin, card.kind, card.title, card.resolvedStart, card.resolvedEnd],
      ['chat', 'context', 'Imports the token helpers', 2, 3],
    );
  });

  it('also registers in the folder a chat starts in, serving this repository', async () => {
    // As for the first folder of a multi-root workspace that is not this repository.
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-chat-')));
    const places = [root(), other];
    await api.chat.connect(root(), places);
    assert.strictEqual(servedRepo(api.chat.registered(other)), root());
    assert.deepStrictEqual(api.chat.connectedPlaces(root(), places), places);
    // A registration serving another repository is left alone.
    await api.chat.disconnect('/elsewhere', [other]);
    assert.ok(api.chat.registered(other));
    await api.chat.disconnect(root(), places);
    assert.strictEqual(api.chat.registered(other), undefined);
    await api.chat.connect(root(), [root()]);
  });

  it('moves a connection made under the earlier name', async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-chat-')));
    const legacy = { ...api.chat.config(root()), args: ['/old/mcp.js', '--repo', '/old/diff'] };
    run('-C', other, 'init', '-q');
    // As the extension under its earlier name left it.
    execFileSync(
      fakeClaude(),
      ['mcp', 'add-json', 'erudite', JSON.stringify(legacy), '-s', 'local'],
      {
        cwd: other,
        env: process.env,
      },
    );
    assert.ok(api.chat.registered(other, 'erudite'));
    await api.chat.keepCurrent(root(), [root(), other]);
    assert.strictEqual(api.chat.registered(other, 'erudite'), undefined);
    for (const place of [root(), other]) {
      assert.strictEqual(servedRepo(api.chat.registered(place)), root());
    }
  });

  it('points a connection at the repository again after its folder moved', async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-desk-chat-')));
    const gone = { ...api.chat.config('/nowhere/old-folder') };
    execFileSync(
      fakeClaude(),
      ['mcp', 'add-json', 'review-desk', JSON.stringify(gone), '-s', 'local'],
      {
        cwd: other,
        env: process.env,
      },
    );
    await api.chat.keepCurrent(root(), [root(), other]);
    for (const place of [root(), other]) {
      assert.strictEqual(servedRepo(api.chat.registered(place)), root());
    }
  });

  it('disconnects', async () => {
    assert.strictEqual(await vscode.commands.executeCommand('reviewDesk.disconnectChat'), true);
    assert.strictEqual(api.chat.registered(root()), undefined);
  });
});
