/**
 * Verifies the pinned binary artifacts after install.
 *
 * These live in Git LFS. The failure this exists to catch is a clone or
 * a CI/Vercel build where LFS never ran: git leaves a ~130 byte text
 * pointer in place of the file, everything looks present, and the first
 * thing to touch the model fails with an unhelpful ONNX parse error at
 * runtime. Hashing on install turns that into a clear message at the
 * moment it can still be fixed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'models/manifest.json'), 'utf8'));

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';
let failures = 0;

for (const entry of manifest.models) {
  const path = join(root, entry.path);

  if (!existsSync(path)) {
    console.error(`MISSING  ${entry.path}`);
    failures += 1;
    continue;
  }

  const bytes = readFileSync(path);

  if (bytes.length < 1024 && bytes.toString('utf8').startsWith(LFS_POINTER)) {
    console.error(
      `LFS POINTER  ${entry.path}\n` +
        '         This is an unresolved Git LFS pointer, not the file.\n' +
        '         Run: git lfs install && git lfs pull',
    );
    failures += 1;
    continue;
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) {
    console.error(
      `HASH MISMATCH  ${entry.path}\n` +
        `         expected ${entry.sha256}\n` +
        `         actual   ${actual}  (${statSync(path).size} bytes)`,
    );
    failures += 1;
    continue;
  }

  console.log(`ok  ${entry.path}  ${(bytes.length / 1024).toFixed(0)}KB`);
}

if (failures > 0) {
  console.error(`\n${failures} pinned artifact(s) failed verification.`);
  process.exit(1);
}
