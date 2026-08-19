#!/usr/bin/env node
// Generates integrity.json — the signed-build manifest of expected SHA-256
// hashes for every core file. Re-run after changing any source file:
//   npm run integrity
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const INCLUDE = new Set(['.html', '.js', '.css', '.webmanifest']);
const SKIP_DIRS = new Set(['node_modules', 'tools', '.git']);
const SKIP_FILES = new Set(['integrity.json']);

async function walk(dir, out = []) {
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (SKIP_DIRS.has(name)) continue;
    const s = await stat(full);
    if (s.isDirectory()) await walk(full, out);
    else if (INCLUDE.has(extname(name)) && !SKIP_FILES.has(rel)) out.push(rel);
  }
  return out;
}

const files = (await walk(ROOT)).sort();
const entries = [];
for (const rel of files) {
  const text = await readFile(join(ROOT, rel), 'utf8');
  const sha256 = createHash('sha256').update(text).digest('hex');
  entries.push({ path: rel.split('\\').join('/'), sha256 });
}

const manifest = { generatedAt: new Date().toISOString(), count: entries.length, files: entries };
await writeFile(join(ROOT, 'integrity.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`integrity.json written — ${entries.length} files hashed.`);
