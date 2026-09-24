/**
 * Verifies that load-bearing comments and documentation are actually in
 * the files, rather than merely claimed by a commit message.
 *
 * This exists because a str.replace with a needle that does not match is
 * a silent no-op. A code edit that fails to apply usually breaks the
 * typecheck or a test; a PROSE edit that fails to apply looks exactly
 * like one that succeeded. That is how 811b305 shipped a commit message
 * describing an anchor rewrite the file never received.
 *
 * Every entry below is a claim some commit made. Whitespace and line
 * wrapping are normalised, so a phrase that wraps across lines still
 * matches.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{file: string, claim: string, phrase: string}[]} */
const CLAIMS = [
  // --- 2a05c6e: deployment gotchas ---
  ['CLAUDE.md', 'deployment gotchas section exists', '## Deployment gotchas'],
  ['CLAUDE.md', 'local vercel build does not reproduce the trace', 'does not reproduce the real file trace'],
  ['CLAUDE.md', 'the measured bundle size', '36.86MB'],
  ['CLAUDE.md', 'Vercel needs Git LFS enabled', 'Vercel needs Git LFS switched on'],
  ['CLAUDE.md', '.npmrc is load-bearing', '.npmrc` is load-bearing'],
  ['CLAUDE.md', 'side-effects cache can make a fix inert', "side-effects cache can make an install-config fix inert"],
  ['CLAUDE.md', 'nothing is proven until invoked', 'Nothing is proven about the native stack until it is invoked'],

  // --- 2a05c6e: the three probe fixes, each naming its symptom ---
  ['packages/features/src/scrfd.ts', 'webpackIgnore names its symptom', 'Module parse failed'],
  ['packages/features/src/onnx-detector.ts', 'webpackIgnore comment on both call sites', 'webpackIgnore is load-bearing'],
  ['apps/web/next.config.ts', 'externalising @pps/features names its symptom', 'FIRST INVOCATION, NOT AT BUILD TIME'],
  ['apps/web/package.json', 'native deps note names its symptom', 'FIRST INVOCATION, NOT AT BUILD TIME'],

  // --- CUDA skip ---
  ['.npmrc', 'says it is load-bearing', 'LOAD-BEARING'],
  ['.npmrc', 'explains the linux/x64-only CUDA default', 'Every platform requires nothing EXCEPT linux/x64'],
  ['.npmrc', 'explains the side-effects cache', 'pnpm caches the FILES A POSTINSTALL PRODUCED'],

  // --- explicit sharpness basis (3c3c388) ---
  ['packages/schema/src/features.ts', 'null is not a synonym for zero', 'It is not a synonym for zero'],
  ['packages/schema/src/features.ts', 'pitch null rather than a fabricated zero', 'Emitting 0 would be worse than emitting nothing'],
  ['packages/scoring/src/pixel-axes.ts', 'null means unmeasurable', 'Null means unmeasurable, never "measured as zero"'],
  ['packages/scoring/src/confidence.ts', 'penalty over measured pose only', 'contributes nothing rather than contributing a fabricated zero'],
  ['packages/features/src/extract.ts', 'returns null never 0', 'Returns null - never 0'],

  // --- HEIC orientation (11c6eb0) ---
  ['packages/features/src/normalize.ts', 'HEVC vs AV1 note', 'no HEVC codec'],
  ['packages/features/src/normalize.ts', 'why EXIF orientation is re-applied', 'heic-convert throws EXIF away'],

  // --- face detection (e417de2) ---
  ['packages/features/src/face.ts', 'largest box, not highest confidence', 'Not highest confidence'],
  ['packages/features/src/scrfd.ts', 'why SCRFD over MediaPipe', 'ModuleFactory not set'],

  // --- rubric (4fd6a9a) ---
  ['packages/features/src/rubric.ts', 'banner on the two 400s', 'TWO THINGS THAT RETURN HTTP 400'],
  ['packages/features/src/rubric.ts', 'oneOf rejection recorded', "Schema type 'oneOf' is not supported"],
  ['packages/features/src/rubric.ts', 'context vs clutter note', 'CONTEXT vs CLUTTER'],
  ['packages/features/src/rubric.ts', 'no profession inference', 'Do not reason about whether a background element relates'],
  ['packages/features/src/rubric.ts', 'evidence describes the photograph', 'EVIDENCE DESCRIBES THE PHOTOGRAPH, NEVER THE PERSON'],
  ['packages/features/src/rubric.ts', 'background level 1 is personal/recreational', 'clearly personal or recreational setting'],
  ['packages/features/src/rubric.ts', 'background level 2 drops the relatedness test', 'legible text or signage that draws the eye'],
  ['packages/features/src/rubric.ts', 'background level 4 is a staged backdrop', 'reads as staged rather than incidental'],

  // --- README ---
  ['README.md', 'retention is two-phase', '## Retention runs in two phases'],
  ['README.md', 'dedup shares numbers not rows', '## Dedup shares numbers, never rows'],
  ['README.md', 'CI and branch protection', '## CI and branch protection'],
  ['README.md', 'HEIC needs a real file', '## HEIC needs a real file to test'],
  ['README.md', 'the model is in Git LFS', '## The face detector model is in Git LFS'],
  ['README.md', 'native dependency sizing', '## Native dependency sizing'],

  // --- the rule that exists because of all of the above ---
  ['CLAUDE.md', 'edit scripts must fail loudly', 'Edit scripts must fail loudly'],
  ['CLAUDE.md', 'grep masks the exit status before it', "reports **grep's** exit status, not `cmd`'s"],
  ['CLAUDE.md', 'pipefail is set in the workflow', 'defaults: run: shell: bash'],
  ['.github/workflows/ci.yml', 'workflow sets pipefail', 'shell: bash'],

  // --- the orphan audit and the provisional knots ---
  ['packages/scoring/src/weights/v1.ts', 'the knots say they are provisional', 'DO NOT HAND-TUNE THESE NUMBERS'],
  ['packages/scoring/src/weights/v1.ts', 'Prompt 11 replaces the file wholesale', 'Prompt 11 replaces this file wholesale'],
  ['packages/schema/src/roles.ts', 'every feature declares what it is for', 'What every field in the feature vector is FOR'],
  ['packages/schema/src/roles.ts', 'a gap is named as a gap, not filed as diagnostic', "role: 'gap'"],

  // --- packages/eval: claims that are load-bearing because a wrong
  //     number here invalidates every conclusion drawn from it ---
  ['packages/eval/src/metrics.ts', 'alpha warns what a wrong implementation costs', 'GET THIS WRONG AND EVERY DOWNSTREAM CONCLUSION IS WRONG'],
  ['packages/eval/src/metrics.ts', 'pairwise accuracy is the headline, not MSE', 'THIS IS THE HEADLINE NUMBER, not MSE'],
  ['packages/eval/src/metrics.test.ts', 'alpha is checked against a published value, not its own output', 'The expectation is the reference value, not ours'],
  ['packages/eval/src/metrics.test.ts', 'the cross-check against an independent implementation is recorded', 'All 41 agreed to within 4.4e-16'],
  ['packages/eval/src/split.ts', 'splits cut on people because phash cannot see them', 'so phashDedup will not catch them'],
  ['packages/eval/src/split.ts', 'nested CV says what conflating the loops costs', 'by roughly 3-5 points'],
  ['packages/eval/src/ceiling.ts', 'the ceiling explains what it makes visible', 'A model cannot be more consistent with the labels than the labels are with themselves'],
  ['packages/eval/src/ceiling.ts', 'comparing unlike statistics is called out', 'produces a chart that means nothing'],
  ['packages/eval/src/labels.ts', 'the parser says why it is schema-agnostic', 'deliberately schema-agnostic about axis names'],

  // --- corpus collection ---
  ['.gitignore', 'data/* is a pattern, not a typo', 'git cannot re-include a file whose PARENT DIRECTORY is excluded'],
  ['training/queries.ts', 'says why the bad queries exist', 'nobody uploads an image and labels it'],
  ['training/queries.ts', 'a query variant is not a label', 'These are query terms, not labels'],
  ['training/collect-corpus.ts', 'extraction runs before any labelling spend', 'Labelling is the only irreversible spend'],
  ['training/collect-corpus.ts', 'keeping the vectors is justified against the architecture rule', 'retraining must never re-run it'],
  ['training/pexels.ts', 'the two hosts have different rules', 'a CDN. Not part of the quota'],
  ['training/pexels.ts', 'the quota is read from headers, not counted locally', 'A local counter is wrong the moment anything else uses the same key'],
  ['training/manifest.ts', 'manifest.csv is the committed provenance record', 'It holds no pixels'],
  ['training/README.md', 'the bad queries have a section explaining themselves', '### Why the BAD queries exist'],
  ['training/collect-corpus.ts', 'a right total can hide a short variant', 'A total that comes out right can still hide a variant that came up short'],
  ['training/pexels.ts', 'large2x must not come back', 'DO NOT "optimise" this back to large2x'],
  ['training/pexels.ts', 'the measured evidence for that, not just the assertion', 'every single image came back exactly 1300px tall'],
  ['training/pexels.ts', 'the pre-filter is named as load-bearing from here', 'is not redundant caching logic'],
  // Phrase kept inside one line: the squash below rejoins block-comment
  // continuations, not `//` line comments, so a phrase that spans two
  // `//` lines can never match.
  ['training/collect-corpus.ts', 'the pre-filter says why it is not a duplicate check', "protects the bandwidth, and neither can do the other's job"],

  // --- the validation wall ---
  ['training/paths.ts', 'the wall says why it is mechanical, not remembered', 'A held-out set is only held out until the first time someone looks at it'],
  ['training/paths.ts', 'and that a leak cannot be undone', 'the only honest fix is 125 new hand-labelled images'],
  ['training/fit-isolation.test.ts', 'neither half of the guard is sufficient alone', 'Neither catches everything alone'],
  ['training/extract-validation.ts', 'says why both pre-checks run before any write', 'because both failures are silent otherwise'],
  ['training/calibrate.ts', 'in-sample correlation is named as flattering', 'an in-sample number and it always flatters'],
  ['training/calibrate.ts', 'scale invariance is not an exemption from the top-knot check', 'and that is the failure that actually bites'],
  ['training/isotonic-fit.ts', 'two-sided axes are reduced before fitting', 'a monotone fit cannot represent'],

  // --- the two measurement-definition fixes ---
  ['packages/scoring/src/compute.ts', 'framingRaw says why it is a reciprocal', 'The subtract-and-clamp form saturates'],
  ['packages/scoring/src/compute.ts', 'and records the measured cost of the old form', '53 of them - 42% of the data piled on one'],
  ['packages/scoring/src/compute.ts', 'lightingRaw runs on the face, not the frame', 'FIT THE LIGHTING MAP OVER THIS VALUE, never over dynamicRange'],
  ['packages/scoring/src/weights/v1.ts', 'resolution is spec-derived, not fitted', 'SPEC-DERIVED, NOT FITTED. Do not learn this map'],
  ['packages/scoring/src/weights/v1.ts', 'sharpness is left unfitted on purpose', 'UNFITTED. Still the original hand-set ladder'],
  ['packages/scoring/src/weights/v1.ts', 'the lighting map domain changed with the scalar', 'THE DOMAIN CHANGED'],
  ['packages/schema/src/features.ts', 'face exposure explains the backlit failure', 'a backlit portrait scores well on it while the face itself is unreadable'],
  ['training/calibrate.ts', 'the distribution check is standing, not ad hoc', 'Printed for EVERY axis on EVERY run'],

  // --- the three decisions ---
  ['packages/scoring/src/weights/v1.ts', 'lighting is a sanity check, not a quality model', 'clipping-and-exposure sanity check, not a lighting quality model'],
  ['packages/scoring/src/weights/v1.ts', 'and says not to try fitting it again', 'Do not fit this. Do not widen it to chase a correlation'],
  ['packages/scoring/src/weights/v1.ts', 'the framing knots span the full scale again', 'PROVISIONAL, HAND-SET, SPANNING THE FULL 1-5'],
  ['packages/scoring/src/weights.ts', 'the lighting demotion records its reason', 'an axis nobody can validate should not vote like one that has been'],
  ['docs/calibration-notes.md', 'the negative result is recorded', 'REJECTED — mean facial exposure as a lighting quality model'],
  ['docs/calibration-notes.md', 'with the number that rules it out', 'best two-sided band, centre searched 60→180'],
  ['docs/calibration-notes.md', 'and the correction to the earlier held-out figure', 'An earlier run reported 0.681'],
  ['docs/calibration-notes.md', 'directional features are named as the missing piece', 'key/fill ratio across the face'],
  ['packages/schema/src/features.ts', 'exposureDelta is cached against the revisit', 'The backlight signature'],
  ['training/reextract.ts', 'says why the collector cannot do this job', 'it is resumable by design'],
  ['docs/calibration-notes.md', 'the two-labeller failure is recorded', 'Do not merge label sets that share no overlap'],
  ['docs/calibration-notes.md', 'with the evidence that rules the merge out', 'At the same measurement the two passes disagree by two whole points'],
  ['training/calibrate.ts', 'the top-up says it was labelled before measuring', 'BEFORE framingRaw was computed'],
  ['packages/scoring/src/score.ts', 'a decline is a finding, not missing data', 'A DECLINE IS A FINDING, NOT MISSING DATA'],
  ['packages/scoring/src/score.ts', 'the cap is applied after renormalising, and why', 'renormalising is exactly the step that let a declined photograph'],
  ['packages/scoring/src/weights/v1.ts', 'the band is derived from observation with its n', 'DERIVED FROM OBSERVATION, n=12'],
  ['packages/scoring/src/weights/v1.ts', 'the LinkedIn denominator mismatch is recorded', 'DIFFERENT DENOMINATOR'],
  ['packages/scoring/src/weights/v1.ts', 'the withdrawn framing fit is explained', 'It had disabled the axis in production'],
  ['packages/eval/src/overlap.ts', 'the overlap rule records the failure it came from', 'The disagreement was only visible between them'],
  ['docs/calibration-notes.md', 'the no-merge-without-overlap rule is written down', 'RULE — no merge without overlap'],
].map(([file, claim, phrase]) => ({ file, claim, phrase }));

/**
 * Normalises away line wrapping AND block-comment continuation markers,
 * so a phrase that wraps mid-sentence across ` * ` prefixes still
 * matches. Without this the checker reports false positives on exactly
 * the long explanatory comments it exists to protect.
 */
const squash = (s) =>
  s
    .replace(/\n\s*\*\s?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

let failures = 0;
const byFile = new Map();
for (const entry of CLAIMS) {
  if (!byFile.has(entry.file)) {
    try {
      byFile.set(entry.file, squash(readFileSync(join(root, entry.file), 'utf8')));
    } catch {
      byFile.set(entry.file, null);
    }
  }
  const body = byFile.get(entry.file);
  const ok = body !== null && body.includes(squash(entry.phrase));
  if (!ok) {
    failures += 1;
    console.error(`MISSING  ${entry.file}\n         claim : ${entry.claim}\n         phrase: "${entry.phrase}"`);
  }
}

console.log(
  `${CLAIMS.length - failures}/${CLAIMS.length} documented claims verified against the files.`,
);
if (failures > 0) {
  console.error(`\n${failures} claim(s) are not in the files. A commit said otherwise.`);
  process.exit(1);
}
