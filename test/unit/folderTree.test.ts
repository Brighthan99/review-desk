import { describe, expect, it } from 'vitest';
import { buildFolderTree, type FolderNode } from '../../src/review/folderTree';

function show(n: FolderNode<{ path: string }>, indent = ''): string[] {
  return [
    ...[...n.folders.values()].flatMap((f) => [`${indent}${f.name}/`, ...show(f, indent + '  ')]),
    ...n.files.map((f) => `${indent}${f.path.slice(f.path.lastIndexOf('/') + 1)}`),
  ];
}

describe('buildFolderTree', () => {
  it('keeps the folder structure and folds single-child chains', () => {
    const tree = buildFolderTree(
      [
        'src/auth/session.ts',
        'src/auth/refresh.ts',
        'src/lib/api-client.ts',
        'test/auth/session.test.ts',
        'README.md',
      ].map((path) => ({ path })),
    );
    expect(show(tree)).toEqual([
      'src/',
      '  auth/',
      '    session.ts',
      '    refresh.ts',
      '  lib/',
      '    api-client.ts',
      'test/auth/',
      '  session.test.ts',
      'README.md',
    ]);
    expect(tree.folders.get('test')?.path).toBe('test/auth');
  });
});
