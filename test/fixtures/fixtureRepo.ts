import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Builds a small git repository used by unit and integration tests.
// main holds the base project; each feat/* branch is one review scenario:
//   feat/refresh  small behavioural change across a few files (matches the mockups)
//   feat/rename   a renamed file with a small edit
//   feat/big      a large diff, a binary file and a file without a trailing newline
// The repository is left on feat/refresh, which is also tagged fixture-refresh.

export interface FixtureRepo {
  dir: string;
  git(...args: string[]): string;
}

const MAIN_FILES: Record<string, string> = {
  'package.json': '{\n  "name": "my-app",\n  "version": "1.0.0"\n}\n',
  'README.md': '# my-app\n\nSession handling sample.\n',
  'src/index.ts': "export { getSession } from './auth/session';\n",
  'src/auth/token.ts': [
    "import { jwtDecode } from 'jwt-decode';",
    '',
    'export interface Token {',
    '  access: string;',
    '  refresh: string;',
    '  exp: number;',
    '}',
    '',
    '/** Treat a token as expired 30 seconds early. */',
    'const SKEW_MS = 30_000;',
    '',
    'export function isExpired(token: Token): boolean {',
    '  return Date.now() + SKEW_MS >= token.exp * 1000;',
    '}',
    '',
    'export function decode(token: Token) {',
    '  return jwtDecode(token.access);',
    '}',
    '',
  ].join('\n'),
  'src/auth/refresh.ts': [
    "import type { Token } from './token';",
    '',
    'export async function refresh(token: Token) {',
    "  const res = await fetch('/auth/refresh', { method: 'POST' });",
    '  if (!res.ok) return null;',
    '  return res.json();',
    '}',
    '',
  ].join('\n'),
  'src/auth/session.ts': [
    "import { decode } from './token';",
    '',
    '/** Read the session from the request cookie. */',
    'export async function getSession(req: Request) {',
    '  const token = req.cookies.token;',
    '  if (!token) return null;',
    '  return decode(token);',
    '}',
    '',
  ].join('\n'),
  'src/lib/http.ts': [
    '/** Minimal JSON helpers around fetch. */',
    '',
    'export async function get(url: string) {',
    '  const res = await fetch(url);',
    '  return res.json();',
    '}',
    '',
    'export async function post(url: string, body: unknown) {',
    "  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });",
    '  return res.json();',
    '}',
    '',
    'export async function remove(url: string) {',
    "  const res = await fetch(url, { method: 'DELETE' });",
    '  return res.ok;',
    '}',
    '',
  ].join('\n'),
  'src/lib/api-client.ts': [
    "import { get } from './http';",
    '',
    'export async function call(url: string) {',
    '  const res = await get(url);',
    '  if (res.status === 401) {',
    "    await fetch('/auth/refresh', { method: 'POST' });",
    '    return get(url);',
    '  }',
    '  return res;',
    '}',
    '',
  ].join('\n'),
  'test/auth/session.test.ts': [
    "import { getSession } from '../../src/auth/session';",
    '',
    "test('no token', async () => {",
    '  expect(await getSession({ cookies: {} } as Request)).toBeNull();',
    '});',
    '',
  ].join('\n'),
};

const REFRESH_CHANGES: Record<string, string> = {
  'src/auth/session.ts': [
    "import { decode, isExpired } from './token';",
    "import { refresh } from './refresh';",
    '',
    '/** Read the session from the request cookie. */',
    'export async function getSession(req: Request) {',
    '  const token = req.cookies.token ?? readBearer(req);',
    '  if (!token) return null;',
    '  if (isExpired(token)) {',
    '    const next = await refresh(token);',
    '    if (!next) return null;',
    '    setCookie(req, next);',
    '    return decode(next);',
    '  }',
    '  return decode(token);',
    '}',
    '',
    'function readBearer(req: Request) {',
    '  const h = req.headers.authorization;',
    "  return h?.replace(/^Bearer /, '');",
    '}',
    '',
  ].join('\n'),
  'src/auth/refresh.ts': [
    "import type { Token } from './token';",
    '',
    'export async function refresh(token: Token) {',
    '  const res = await fetch(`${AUTH_URL}/refresh`, {',
    "    method: 'POST',",
    "    headers: { 'x-refresh-token': token.refresh },",
    '  });',
    '  if (!res.ok) return null;',
    '  return res.json();',
    '}',
    '',
  ].join('\n'),
  'src/lib/api-client.ts': [
    "import { get } from './http';",
    '',
    'export async function call(url: string) {',
    '  return get(url);',
    '}',
    '',
  ].join('\n'),
  'test/auth/session.test.ts': [
    "import { getSession } from '../../src/auth/session';",
    '',
    "test('no token', async () => {",
    '  expect(await getSession({ cookies: {} } as Request)).toBeNull();',
    '});',
    '',
    "test('reads bearer token', async () => {",
    "  const req = { cookies: {}, headers: { authorization: 'Bearer abc' } } as Request;",
    '  expect(await getSession(req)).not.toBeNull();',
    '});',
    '',
  ].join('\n'),
};

// 1x1 transparent PNG.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

export function openFixtureRepo(dir: string): FixtureRepo {
  return { dir, git: (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }) };
}

/** A private copy of an already built fixture repository, much faster than building one. */
export function copyFixtureRepo(template: string, dir: string): FixtureRepo {
  fs.cpSync(template, dir, { recursive: true });
  return openFixtureRepo(dir);
}

export function createFixtureRepo(dir: string): FixtureRepo {
  fs.mkdirSync(dir, { recursive: true });
  let tick = 0;
  const git = (...args: string[]): string => {
    const date = `2026-01-01T00:00:${String(tick).padStart(2, '0')}Z`;
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  const write = (files: Record<string, string | Buffer>) => {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  };
  const commit = (message: string) => {
    tick++;
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'commit.gpgsign', 'false');
  write(MAIN_FILES);
  commit('Initial project');

  git('switch', '-q', '-c', 'feat/rename', 'main');
  git('mv', 'src/lib/http.ts', 'src/lib/httpClient.ts');
  write({
    'src/lib/httpClient.ts': MAIN_FILES['src/lib/http.ts'].replace(
      'const res = await fetch(url);',
      "const res = await fetch(url, { headers: { accept: 'application/json' } });",
    ),
    'src/lib/api-client.ts': MAIN_FILES['src/lib/api-client.ts'].replace(
      "from './http'",
      "from './httpClient'",
    ),
  });
  commit('Rename http to httpClient');

  git('switch', '-q', '-c', 'feat/big', 'main');
  const big = Array.from(
    { length: 600 },
    (_, i) => `export const value${i} = ${i}; // generated line ${i}`,
  );
  write({
    'src/generated/values.ts': big.join('\n') + '\n',
    'assets/logo.png': PNG,
    'README.md': '# my-app\n\nSession handling sample.\nNo trailing newline here.',
  });
  commit('Add generated values and logo');

  git('switch', '-q', '-c', 'feat/refresh', 'main');
  write(REFRESH_CHANGES);
  commit('Refresh expired tokens on the server');
  git('tag', 'fixture-refresh');

  return { dir, git };
}
