/**
 * Fails when a pinned artifact is an unresolved Git LFS pointer.
 *
 * Vercel's build clones without LFS by default. The symptom is not a
 * missing file - it is a 130-byte text file where the model should be,
 * which only fails at runtime with an opaque ONNX parse error. Run this
 * in the build so it fails at build time with a clear message instead.
 *
 * Fix, if it fires: enable "Git LFS" in the Vercel project's Git
 * settings, or set VERCEL_GIT_LFS=1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'models/manifest.json'), 'utf8'));
const pointer = 'version https://git-lfs.github.com/spec/v1';

for (const entry of manifest.models) {
  const head = readFileSync(join(root, entry.path)).subarray(0, 64).toString('utf8');
  if (head.startsWith(pointer)) {
    console.error(
      `\n${entry.path} is an unresolved Git LFS pointer.\n` +
        'Enable Git LFS for this project (Vercel: Settings > Git > Git LFS),\n' +
        'or locally: git lfs install && git lfs pull\n',
    );
    process.exit(1);
  }
}
console.log('Git LFS artifacts resolved.');
