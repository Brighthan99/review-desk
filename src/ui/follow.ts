import * as path from 'node:path';
import * as vscode from 'vscode';
import { filePath } from '../review/diffParser';
import type { ResolvedAnnotation } from '../review/model';
import { diffDigest, type ReviewTarget } from '../review/target';
import type { FileUse } from '../shared/protocol';

const MAX_SYMBOLS = 40;
const MAX_USES = 50;
const TIMEOUT_MS = 8000;

/** Added lines of the change, by file and new-side line number. */
function addedLines(target: ReviewTarget): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  for (const f of target.files) {
    const lines = new Map<number, string>();
    for (const h of f.hunks) {
      for (const l of h.lines)
        if (l.kind === 'add' && l.newLine !== null) lines.set(l.newLine, l.text);
    }
    if (lines.size) out.set(filePath(f), lines);
  }
  return out;
}

function flatten(
  symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[],
): { name: string; pos: vscode.Position }[] {
  const out: { name: string; pos: vscode.Position }[] = [];
  const walk = (s: vscode.DocumentSymbol | vscode.SymbolInformation, depth: number) => {
    if ('selectionRange' in s) {
      out.push({ name: s.name, pos: s.selectionRange.start });
      if (depth < 1) for (const c of s.children) walk(c, depth + 1);
    } else {
      out.push({ name: s.name, pos: s.location.range.start });
    }
  };
  for (const s of symbols) walk(s, 0);
  return out.slice(0, MAX_SYMBOLS);
}

function withTimeout<T>(p: Thenable<T>, fallback: T): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS)),
  ]);
}

type Use = Omit<FileUse, 'cardId' | 'cardNumber'>;

/** Reference searches run at once: each one asks the language server. */
const PARALLEL = 4;
/** Uses found per file version and change, most recent last. */
const found = new Map<string, Use[]>();
const MAX_FOUND = 20;

/** Where the file's symbols are referenced on added lines, a few searches at a time. */
async function searchUses(
  target: ReviewTarget,
  uri: vscode.Uri,
  added: Map<string, Map<number, string>>,
): Promise<Use[]> {
  const symbols = await withTimeout(
    vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
    >('vscode.executeDocumentSymbolProvider', uri),
    undefined,
  );
  const list = flatten(symbols ?? []);
  const seen = new Set<string>();
  const uses: Use[] = [];
  for (let i = 0; i < list.length && uses.length < MAX_USES; i += PARALLEL) {
    const batch = list.slice(i, i + PARALLEL);
    const results = await Promise.all(
      batch.map((sym) =>
        withTimeout(
          vscode.commands.executeCommand<vscode.Location[] | undefined>(
            'vscode.executeReferenceProvider',
            uri,
            sym.pos,
          ),
          undefined,
        ),
      ),
    );
    batch.forEach((sym, j) => {
      for (const ref of results[j] ?? []) {
        if (ref.uri.scheme !== 'file') continue;
        const file = path.relative(target.root, ref.uri.fsPath).split(path.sep).join('/');
        const line = ref.range.start.line + 1;
        const text = added.get(file)?.get(line);
        const key = `${file}:${line}`;
        if (text === undefined || seen.has(key)) continue;
        seen.add(key);
        uses.push({ file, line, text: text.trim(), symbol: sym.name });
      }
    });
  }
  return uses;
}

/**
 * Where the symbols of an unchanged file are used on the added lines of the change, found
 * with the editor's own symbol and reference providers. Kept per file version and change,
 * so going back to a file asks the language server nothing.
 */
export async function findUses(
  target: ReviewTarget,
  annotations: ResolvedAnnotation[],
  uri: vscode.Uri,
): Promise<FileUse[]> {
  const added = addedLines(target);
  if (!added.size) return [];
  const version =
    vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.version ?? 0;
  const key = `${uri.toString()}\n${version}\n${diffDigest(target)}`;
  let uses = found.get(key);
  if (uses) found.delete(key);
  else uses = await searchUses(target, uri, added);
  found.set(key, uses);
  if (found.size > MAX_FOUND) found.delete(found.keys().next().value!);

  return uses
    .map((u): FileUse => {
      const card = annotations.find(
        (a) =>
          a.side === 'new' &&
          a.file === u.file &&
          u.line >= a.resolvedStart &&
          u.line <= a.resolvedEnd,
      );
      return { ...u, cardId: card?.id, cardNumber: card?.number };
    })
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
    .slice(0, MAX_USES);
}
