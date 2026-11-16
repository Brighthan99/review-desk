import { describe, expect, it } from 'vitest';
import { fileNamed, filesNamed } from '../../src/shared/fileNames';
import { samePath } from '../../src/review/realpath';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('finding a file by the name the AI wrote', () => {
  const files = ['src/auth/session.ts', 'src/api/session.ts', 'src/lib/httpClient.ts', 'README.md'];

  it('takes an exact path first, else a unique path suffix', () => {
    expect(fileNamed('src/auth/session.ts', files)).toBe('src/auth/session.ts');
    expect(fileNamed('./README.md', files)).toBe('README.md');
    expect(fileNamed('httpClient.ts', files)).toBe('src/lib/httpClient.ts');
    expect(fileNamed('auth/session.ts', files)).toBe('src/auth/session.ts');
  });

  it('names none when several end with it, or none does', () => {
    expect(filesNamed('session.ts', files)).toEqual(['src/auth/session.ts', 'src/api/session.ts']);
    expect(fileNamed('session.ts', files)).toBeUndefined();
    expect(fileNamed('Client.ts', files)).toBeUndefined(); // a suffix of the path, not of a folder
    expect(fileNamed('nope.ts', files)).toBeUndefined();
  });
});

describe('comparing folders through symlinks', () => {
  it('sees a folder and a symlink to it as the same, and a missing path as itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-same-'));
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    try {
      expect(samePath(dir, link)).toBe(true);
      expect(samePath(`${dir}/gone`, `${dir}/gone`)).toBe(true);
      expect(samePath(dir, os.tmpdir())).toBe(false);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(dir, { recursive: true });
    }
  });
});
