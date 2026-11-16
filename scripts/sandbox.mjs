// Makes a throwaway repository to try Review Desk's comparison sides and worktrees by hand,
// and opens it in a new VS Code window:
//
//   npm run sandbox             open it (making it first if it is missing)
//   npm run sandbox -- --fresh  make it again from scratch
//   (--no-open: make it without opening a window)
//
// Everything lives under ~/review-desk-sandbox (the repository, its bare "origin" and the
// worktrees Review Desk puts next to the repository), so removing that folder cleans up.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = path.join(os.homedir(), 'review-desk-sandbox');
const repo = path.join(home, 'repo');
const origin = path.join(home, 'origin.git');
const fresh = process.argv.includes('--fresh');

let tick = 0;
const git = (cwd, ...args) => {
  // Fixed dates, so the history reads the same every time.
  const date = `2026-01-0${1 + Math.floor(tick / 10)}T09:${String(tick % 60).padStart(2, '0')}:00Z`;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
};
const write = (files) => {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
};
const commit = (message) => {
  tick++;
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
};

function make() {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Sandbox');
  git(repo, 'config', 'user.email', 'sandbox@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');

  write({
    'README.md': '# shop\n\nA tiny shop backend to try Review Desk on.\n',
    'src/cart.ts': [
      'export interface Item {',
      '  id: string;',
      '  price: number;',
      '  quantity: number;',
      '}',
      '',
      'export function total(items: Item[]): number {',
      '  let sum = 0;',
      '  for (const item of items) sum += item.price * item.quantity;',
      '  return sum;',
      '}',
      '',
    ].join('\n'),
    'src/user.ts': [
      'export interface User {',
      '  id: string;',
      '  name: string;',
      '}',
      '',
      'const users = new Map<string, User>();',
      '',
      'export function find(id: string): User | undefined {',
      '  return users.get(id);',
      '}',
      '',
    ].join('\n'),
  });
  commit('Start the shop');
  write({ 'src/price.ts': 'export const round = (n: number) => Math.round(n * 100) / 100;\n' });
  commit('Round prices to cents');
  write({
    'README.md': '# shop\n\nA tiny shop backend to try Review Desk on.\n\nRun `npm test`.\n',
  });
  commit('Say how to run the tests');

  // feat/login: two commits on top of main.
  git(repo, 'switch', '-q', '-c', 'feat/login');
  write({
    'src/login.ts': [
      "import { find, type User } from './user';",
      '',
      'export function login(id: string, password: string): User | undefined {',
      '  const user = find(id);',
      '  if (!user || password.length < 8) return undefined;',
      '  return user;',
      '}',
      '',
    ].join('\n'),
  });
  commit('Add a login check');
  write({
    'src/user.ts': [
      'export interface User {',
      '  id: string;',
      '  name: string;',
      '  locked?: boolean;',
      '}',
      '',
      'const users = new Map<string, User>();',
      '',
      'export function find(id: string): User | undefined {',
      '  const user = users.get(id);',
      '  return user?.locked ? undefined : user;',
      '}',
      '',
    ].join('\n'),
  });
  commit('Skip locked users');

  // feat/cache: one commit, later kept only on origin (a remote branch to pick).
  git(repo, 'switch', '-q', '-c', 'feat/cache', 'main');
  write({
    'src/cart.ts': [
      'export interface Item {',
      '  id: string;',
      '  price: number;',
      '  quantity: number;',
      '}',
      '',
      'const totals = new WeakMap<Item[], number>();',
      '',
      'export function total(items: Item[]): number {',
      '  const cached = totals.get(items);',
      '  if (cached !== undefined) return cached;',
      '  let sum = 0;',
      '  for (const item of items) sum += item.price * item.quantity;',
      '  totals.set(items, sum);',
      '  return sum;',
      '}',
      '',
    ].join('\n'),
  });
  commit('Cache cart totals');

  // main moves on after the branches left it ("main has 1 newer commit").
  git(repo, 'switch', '-q', 'main');
  write({
    'src/price.ts':
      'export const round = (n: number) => Math.round(n * 100) / 100;\nexport const cents = (n: number) => Math.round(n * 100);\n',
  });
  commit('Add cents()');

  // A bare origin with every branch; feat/cache then lives only there.
  git(home, 'init', '-q', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main', 'feat/login', 'feat/cache');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'branch', '-q', '-D', 'feat/cache');

  // The main folder reviews feat/login, with an edit not committed yet.
  git(repo, 'switch', '-q', 'feat/login');
  fs.appendFileSync(path.join(repo, 'src/login.ts'), '\nexport const MIN_PASSWORD = 8;\n');

  // A worktree already there, and one whose folder was deleted ("folder missing").
  git(repo, 'worktree', 'add', '-q', path.join(home, 'repo-main'), 'main');
  const gone = path.join(home, 'repo-old');
  git(repo, 'worktree', 'add', '-q', '--detach', gone, 'main~2');
  fs.rmSync(gone, { recursive: true, force: true });
}

if (fresh || !fs.existsSync(path.join(repo, '.git'))) {
  make();
  console.log(`Made ${repo}`);
} else {
  console.log(`Using ${repo} (npm run sandbox -- --fresh makes it again)`);
}

if (!process.argv.includes('--no-open')) {
  const opened = spawnSync('code', ['--new-window', repo], { stdio: 'ignore' });
  if (opened.error || opened.status !== 0) console.log(`Open it in VS Code: ${repo}`);
}

console.log(`
Try it yourself (in the new window, in the Review Desk sidebar):
 1. Start Review: the base is origin/main (the remote's default branch). Expand 'Comparing with origin/main':
    at the top [R] Uncommitted changes (src/login.ts), the 2 commits of feat/login, [L] the base commit,
    'origin/main has 1 newer commit · not included', and the dimmed earlier commits below it.
 2. [R] row → HEAD: the uncommitted changes drop out. [R] again → Work Tree.
 3. Click a commit row in between → Compare from Here: the base moves forward.
    Click a dimmed earlier row to move it back.
 4. [R] row → origin/feat/cache (a remote branch with no local one) → Open in a New Window:
    checks it out in ~/review-desk-sandbox/repo-feat-cache as a local branch feat/cache (tracking origin),
    and the new window starts a review with the same base.
 5. Expand Worktrees (collapsed) at the bottom of the sidebar:
    repo(main folder · this window · reviewed), repo-main, repo-feat-cache(made by Review Desk),
    repo-old(folder missing). Hover a row for Copy Remove Command / Open in New Window.
 6. Click a commit row → Compare up to Here → Open in a New Window: checks that commit out, detached.
 7. Click a commit row → Compare up to Here → Switch to It in This Window:
    asks first about the uncommitted changes, then switches to that commit, detached. (Back: [R] → feat/login → Switch)
    [R] → main → Switch to It in This Window: git refuses, as main is checked out in the repo-main worktree (see the error).
 8. Clean up: rm -rf ~/review-desk-sandbox
`);
