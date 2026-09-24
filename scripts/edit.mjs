/**
 * Exact-match file edit that FAILS LOUDLY when the needle is not found.
 *
 * Use this instead of an inline sed/python/node replace. `str.replace`
 * with a needle that does not match returns the string unchanged and
 * reports nothing, so the edit script exits zero and the commit message
 * describes a change the file never received. That happened in 811b305:
 * the rubric anchors use an em dash, the edit searched for a hyphen, and
 * a rewrite that looked applied was never applied at all.
 *
 *   node scripts/edit.mjs <file> <<'PATCH'
 *   <<<<<<< FIND
 *   exact text to find
 *   =======
 *   replacement text
 *   >>>>>>> REPLACE
 *   PATCH
 *
 * Multiple FIND/REPLACE blocks may appear in one patch. Every block must
 * match exactly once, or nothing is written and the exit code is 1.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2];
if (target === undefined) {
  console.error('usage: node scripts/edit.mjs <file>   (patch on stdin)');
  process.exit(1);
}

const patch = readFileSync(0, 'utf8');
const blocks = [...patch.matchAll(/<<<<<<< FIND\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g)];

if (blocks.length === 0) {
  console.error('No FIND/REPLACE blocks in the patch.');
  process.exit(1);
}

let body = readFileSync(target, 'utf8');
let applied = 0;

for (const [, find, replace] of blocks) {
  const occurrences = body.split(find).length - 1;
  if (occurrences === 0) {
    console.error(`NEEDLE NOT FOUND in ${target}:\n---\n${find}\n---`);
    console.error('Nothing written. Check for an em dash, a smart quote, or wrapped whitespace.');
    process.exit(1);
  }
  if (occurrences > 1) {
    console.error(`NEEDLE MATCHES ${occurrences} TIMES in ${target} - ambiguous:\n---\n${find}\n---`);
    process.exit(1);
  }
  body = body.replace(find, replace);
  applied += 1;
}

writeFileSync(target, body);
console.log(`${applied}/${blocks.length} block(s) applied to ${target}`);
