import * as path from 'node:path';
import * as vscode from 'vscode';
import { leavePending, type PendingStart } from '../review/pending';
import { samePath } from '../review/realpath';
import {
  addWorktree,
  isDirty,
  localName,
  markMadeFor,
  refKind,
  siblingDir,
  switchTo,
  worktreeOf,
  type MadeFor,
} from '../review/worktree';
import type { Prompts } from './prompts';

/**
 * Where a branch or commit is reviewed: checked out in this window, or in a git worktree of
 * its own, opened in a new window (`worktree`) or added to this window as another folder
 * (`folder`). Either way this window's checkout stays as it is.
 */
export type Place = 'here' | 'worktree' | 'folder';

export interface PlaceQuestion {
  root: string;
  ref: string;
  /** The branch it will be on, when that is not `ref` (a pull request not fetched yet). */
  branch?: string;
  title: string;
  placeHolder?: string;
  /** Offer this window first; else the new window, which changes nothing here. */
  hereFirst?: boolean;
}

/** The branch `ref` is checked out as: itself, the local one of a remote one, none for a commit. */
async function branchOf(root: string, ref: string): Promise<string | undefined> {
  const kind = await refKind(root, ref);
  return kind === 'local' ? ref : kind === 'remote' ? localName(ref) : undefined;
}

/** Whether `dir` is one of this window's folders. */
function inWindow(dir: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((f) => samePath(f.uri.fsPath, dir));
}

/** The other worktree that has `branch` checked out, if any (not this folder). */
async function elsewhere(root: string, branch: string | undefined): Promise<string | undefined> {
  const holder = branch && (await worktreeOf(root, branch));
  return holder && !samePath(holder, root) ? holder : undefined;
}

/** Asks where to check a branch or commit out (the default `Prompts.pickPlace`). */
export async function askPlace(q: PlaceQuestion): Promise<Place | undefined> {
  const branch = q.branch ?? (await branchOf(q.root, q.ref));
  const holder = await elsewhere(q.root, branch);
  const worktree = {
    label: '$(multiple-windows) Open in a New Window (git worktree)',
    description: holder ?? siblingDir(q.root, branch ?? q.ref),
    detail: 'This window and its checkout stay as they are.',
    place: 'worktree' as const,
  };
  const folder = {
    label: '$(root-folder) Add to This Window as a Folder (git worktree)',
    description: holder ?? siblingDir(q.root, branch ?? q.ref),
    detail: vscode.workspace.workspaceFile
      ? "The worktree joins this window's folders, which stay as they are."
      : 'The worktree joins this window next to this folder, which stays as it is. Extensions restart once.',
    place: 'folder' as const,
  };
  const here = {
    label: '$(git-branch) Switch to It in This Window',
    description: branch ?? `detached at ${q.ref}`,
    detail: holder
      ? `The worktree ${path.basename(holder)} has it checked out: ${inWindow(holder) ? 'it is reviewed there' : 'its window opens'} instead.`
      : 'Checks it out here, like git switch.',
    place: 'here' as const,
  };
  const picked = await vscode.window.showQuickPick(
    q.hereFirst ? [here, worktree, folder] : [worktree, folder, here],
    {
      title: q.title,
      placeHolder: q.placeHolder ?? 'Where to check it out?',
    },
  );
  return picked?.place;
}

/** A branch or commit to check out for a review, and the review a new window starts. */
export interface CheckOut {
  root: string;
  /** A local or remote branch, or any commit. */
  ref: string;
  place: Place;
  /** What it is, in questions ("pull request #7"); the ref when not given. */
  name?: string;
  /** Recorded with a worktree made for it, for the Worktrees list. */
  purpose?: MadeFor['purpose'];
  /** The review the window of another worktree starts. */
  start: PendingStart;
  /** Ask before switching this window even with nothing uncommitted (a click away). */
  askFirst?: boolean;
}

/**
 * Where the review goes on: this window's folder (`here`), or another folder, whose window
 * (a new one, or this one when the folder is added to it) starts the review left for it.
 */
export interface CheckedOut {
  dir: string;
  here: boolean;
}

/**
 * Checks a branch or commit out for its review, the same way for a pull request, the right
 * side of a comparison and a saved review: here (asking first when uncommitted changes would
 * come along), or in a new worktree whose window starts the review: a new window, or this one
 * with the worktree added as a folder. A branch is checked out in one place only, so one that
 * another worktree has is reviewed in that worktree's folder: in this window when it is one of
 * its folders, else in its window (asking first when it was wanted here); and one this folder
 * has is reviewed here. Undefined when the reviewer said no; git's errors are thrown.
 */
export async function checkOut(c: CheckOut, prompts: Prompts): Promise<CheckedOut | undefined> {
  const name = c.name ?? c.ref;
  const branch = await branchOf(c.root, c.ref);
  const holder = branch && (await worktreeOf(c.root, branch));
  if (holder && samePath(holder, c.root)) return { dir: c.root, here: true };
  if (holder) {
    if (inWindow(holder) || c.place === 'folder') return addToWindow(holder, c.start, prompts);
    if (
      c.place === 'here' &&
      !(await prompts.confirm(
        `The worktree ${holder} has ${name} checked out, so it cannot be checked out here too. Open its window?`,
        'Open Its Window',
        'To review it in this window instead, remove that worktree first (the Remove button of the Worktrees list).',
      ))
    ) {
      return undefined;
    }
    return openWindow(holder, c.start, prompts);
  }
  if (c.place !== 'here') {
    const dir = await prompts.progress(`Checking out ${name} in a new worktree…`, () =>
      addWorktree(c.root, c.ref),
    );
    if (c.purpose) await markMadeFor(dir, c.purpose, c.ref);
    return c.place === 'folder'
      ? addToWindow(dir, c.start, prompts)
      : openWindow(dir, c.start, prompts);
  }
  const dirty = await isDirty(c.root);
  if (dirty || c.askFirst) {
    const message = dirty
      ? `You have uncommitted changes. Switch this window to ${name} anyway? They come along.`
      : `Switch this window to ${name}?`;
    if (!(await prompts.confirm(message, 'Switch'))) return undefined;
  }
  await prompts.progress(`Switching to ${name}…`, () => switchTo(c.root, c.ref));
  return { dir: c.root, here: true };
}

/** Opens `dir` in a new window, whose review starts as `start` says (the default base: `{}`). */
export async function openWindow(
  dir: string,
  start: PendingStart,
  prompts: Prompts,
): Promise<CheckedOut> {
  await leavePending(dir, start);
  await prompts.openFolder(dir);
  return { dir, here: false };
}

/**
 * Reviews `dir` in this window: added as a folder, after which this window starts the review
 * left for it (see GitHubService.resumePending); started now when it is a folder already.
 */
export async function addToWindow(
  dir: string,
  start: PendingStart,
  prompts: Prompts,
): Promise<CheckedOut> {
  await leavePending(dir, start);
  if (inWindow(dir)) await vscode.commands.executeCommand('reviewDesk.resumePending', [dir]);
  else await prompts.addFolder(dir);
  return { dir, here: false };
}
