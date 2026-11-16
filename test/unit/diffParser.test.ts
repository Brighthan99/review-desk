import { describe, expect, it } from 'vitest';
import { filePath, formatForAgent, hunkSpan, parseUnifiedDiff } from '../../src/review/diffParser';

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ export function a() {
 line one
-line two
+line two changed
+line inserted
 line three
 line four
`;

describe('parseUnifiedDiff', () => {
  it('numbers context, added and deleted lines on both sides', () => {
    const [f] = parseUnifiedDiff(MODIFIED);
    expect(f).toMatchObject({ oldPath: 'src/a.ts', newPath: 'src/a.ts', status: 'modified' });
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
    const h = f.hunks[0];
    expect(h).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 });
    expect(h.section).toBe('export function a() {');
    expect(h.lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ['context', 1, 1, 'line one'],
      ['del', 2, null, 'line two'],
      ['add', null, 2, 'line two changed'],
      ['add', null, 3, 'line inserted'],
      ['context', 3, 4, 'line three'],
      ['context', 4, 5, 'line four'],
    ]);
    expect(hunkSpan(h, 'new')).toEqual([1, 5]);
    expect(hunkSpan(h, 'old')).toEqual([1, 4]);
  });

  it('reads a file name with a space, which git ends with a tab', () => {
    const [f] = parseUnifiedDiff(
      [
        'diff --git a/my file.ts b/my file.ts',
        'index 7898192..6178079 100644',
        '--- a/my file.ts\t',
        '+++ b/my file.ts\t',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n'),
    );
    expect([f.oldPath, f.newPath]).toEqual(['my file.ts', 'my file.ts']);
  });

  it('handles added, deleted and renamed files', () => {
    const files = parseUnifiedDiff(`diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/lib/http.ts b/lib/httpClient.ts
similarity index 88%
rename from lib/http.ts
rename to lib/httpClient.ts
index 5555555..6666666 100644
--- a/lib/http.ts
+++ b/lib/httpClient.ts
@@ -1 +1 @@
-a
+b
`);
    expect(files.map((f) => [f.status, f.oldPath, f.newPath, filePath(f)])).toEqual([
      ['added', null, 'new.ts', 'new.ts'],
      ['deleted', 'gone.ts', null, 'gone.ts'],
      ['renamed', 'lib/http.ts', 'lib/httpClient.ts', 'lib/httpClient.ts'],
    ]);
    expect(files[2].similarity).toBe(88);
    expect(hunkSpan(files[0].hunks[0], 'old')).toBeNull();
    expect(files[1].hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newLines: 0 });
  });

  it('marks binary files and missing trailing newlines', () => {
    const files = parseUnifiedDiff(`diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/logo.png differ
diff --git a/README.md b/README.md
index 8888888..9999999 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,2 @@
 # title
-old end
+new end
\\ No newline at end of file
`);
    expect(files[0]).toMatchObject({
      newPath: 'logo.png',
      status: 'added',
      binary: true,
      hunks: [],
    });
    const lines = files[1].hunks[0].lines;
    expect(lines[2]).toMatchObject({ kind: 'add', text: 'new end', noNewlineAtEnd: true });
    expect(lines[1].noNewlineAtEnd).toBeUndefined();
  });

  it('strips CRLF and keeps empty context lines', () => {
    const [f] = parseUnifiedDiff(
      'diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1,3 +1,3 @@\r\n a\r\n\r\n-b\r\n+c\r\n',
    );
    expect(f.hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([
      ['context', 'a'],
      ['context', ''],
      ['del', 'b'],
      ['add', 'c'],
    ]);
  });

  it('reads paths with spaces and quoted unicode', () => {
    const files = parseUnifiedDiff(`diff --git a/my file.ts b/my file.ts
--- a/my file.ts
+++ b/my file.ts
@@ -1 +1 @@
-x
+y
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-x
+y
`);
    expect(files.map(filePath)).toEqual(['my file.ts', 'café.txt']);
  });
});

describe('formatForAgent', () => {
  it('prints both line numbers in front of every line', () => {
    const text = formatForAgent(parseUnifiedDiff(MODIFIED));
    expect(text.split('\n').slice(0, 5)).toEqual([
      '## src/a.ts (modified, +2 −1)',
      '@@ -1,4 +1,5 @@ export function a() {',
      '    1     1 | line one',
      '    2       |-line two',
      '          2 |+line two changed',
    ]);
  });
});
