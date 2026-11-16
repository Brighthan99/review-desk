// Writes ThirdPartyNotices.txt: the license of every package the extension bundles (the
// production dependencies and theirs), which their licenses ask to ship with it.
// Run with `npm run notices` after changing dependencies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dirs = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8' })
  .split('\n')
  .slice(1)
  .filter(Boolean);
const seen = new Map();
for (const dir of dirs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  const file = fs
    .readdirSync(dir)
    .find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f));
  const license =
    typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see its license text');
  seen.set(key, {
    name: pkg.name,
    version: pkg.version,
    license,
    url: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url,
    text: file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : undefined,
  });
}
const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const out = [
  'Review Desk includes the following third-party software. Their licenses follow.',
  '',
  ...entries.map((e) => `- ${e.name} ${e.version} (${e.license})`),
  '',
];
for (const e of entries) {
  out.push('='.repeat(78), `${e.name} ${e.version} — ${e.license}`);
  if (e.url) out.push(e.url.replace(/^git\+/, ''));
  out.push(
    '-'.repeat(78),
    e.text ?? `Licensed under ${e.license}. No license file is included in the package.`,
    '',
  );
}
fs.writeFileSync('ThirdPartyNotices.txt', out.join('\n'));
console.log(`ThirdPartyNotices.txt: ${entries.length} packages`);
