# Project: Profile Photo Scorer

Scores a professional profile photo 1-10 with a per-axis breakdown and
specific, actionable fixes.

## Critical rule
We score the PHOTOGRAPH, never the person. No axis may assess
attractiveness, competence, employability, age, race, or gender. Every
axis must be something the user can change by retaking the photo.

## The eight axes
Computed from pixels (exact, no ML):
  sharpness   - variance of Laplacian
  lighting    - histogram clipping, dynamic range
  resolution  - pixel dimensions
  framing     - face box area / image area, centering

Judged by a vision model (later distilled into a local model):
  background  - clutter, distraction
  attire      - formality LEVEL 1-5, not quality
  expression  - eye contact, natural affect
  solo        - one clear subject

Each axis scores 1-5. A weighted composite maps to the final 1-10.
Context weights (startup / corporate / creative) are hand-set constants,
never learned.

## Stack
- Next.js 15 App Router, TypeScript strict -> Vercel
- Supabase: Postgres + pgvector + Storage
- Heavy image work runs ONLY in Vercel Node functions (sharp needs Node)
- Scoring runs in Supabase Edge Functions (Deno)

## Hard platform constraints
- Supabase Edge: 256MB memory, 2s CPU, 20MB bundle, no sharp, no image
  decoding. Scoring there must be pure arithmetic on a cached feature
  vector. Never attempt inference in an Edge function.
- Vercel: 4.5MB request body cap. Images go browser -> Supabase Storage
  directly via signed URL, never through a Vercel route.

## Architecture rule that matters most
Feature extraction and scoring are SEPARATE. Extraction runs once per
image (~800ms) and caches to Postgres. Scoring is a dot product (~3ms)
over that cache. Retraining must never require re-running extraction.

## packages/scoring must have ZERO dependencies
It runs in Node, Deno, and the browser. No imports outside the standard
library. Pure functions only.

## Conventions
- pnpm workspaces + Turborepo
- zod schemas in packages/schema are the single source of truth
- No `any`. No non-null assertions without a comment explaining why.
- Every module gets a vitest file alongside it.
- data/ and models/ are gitignored. Never commit images.
## Deployment gotchas

Every item here was found the hard way, and every one of them passes a
green build. They fail at first invocation instead.

**`npx vercel build` on macOS does not reproduce the real file trace.**
It emits an ~88KB function with no onnxruntime-node inside it. Do not
use it to check what is in the bundle - it will tell you the native
dependency is missing when it is not, or absent when it is. The deployed
artifact is the only honest source. Measured on iad1: **36.86MB** for
`api/health-onnx`, against the 250MB limit.

**Vercel needs Git LFS switched on** in Settings → Git. Without it the
model arrives as a ~130 byte pointer file, the build succeeds, and ONNX
fails to parse it at runtime. `scripts/check-lfs.mjs` runs on install
and turns that into a clear message.

**`.npmrc` is load-bearing - do not delete it as redundant defaults.**
onnxruntime-node's postinstall manifest requires `[]` on every platform
except `linux/x64`, which defaults to `["cuda12"]` and downloads the
CUDA and TensorRT execution providers from nuget. There is no GPU on
Vercel. It never reproduces on macOS or Windows. ⚠️ Any Dockerfile or
build context that runs `pnpm install` must copy `.npmrc` in first, or
the setting silently does not apply.

**pnpm's side-effects cache can make an install-config fix inert.** It
stores the files a postinstall produced and replays them on later
installs without re-running the script, so a store populated before a
fix keeps handing back the old result - the setting looks ignored. Hence
`side-effects-cache=false`, and a CI cache key that includes the install
config rather than just the lockfile.

**Edit scripts must fail loudly.** `str.replace` with a needle that does
not match returns the text unchanged and exits zero. A code edit that
does not apply usually breaks the typecheck; a PROSE or PROMPT edit that
does not apply looks identical to one that did. `811b305` shipped a
commit message describing a rubric rewrite the file never received - the
anchors use an em dash and the edit searched for a hyphen.

So: use `node scripts/edit.mjs <file>` with a FIND/REPLACE patch on
stdin, which exits non-zero when the needle is missing or ambiguous.
Never accept "the command ran" as evidence an edit applied - read the
file back. `pnpm verify:docs` checks the load-bearing comments and
documentation are present, and runs in CI.

The same trap applies to verification itself, and it is the same root
cause - accepting a proxy for success:

- `cmd | grep ...` reports **grep's** exit status, not `cmd`'s. So does
  `x=$(cmd | head)`: if `cmd` fails, `x` is empty and an assertion built
  on it passes. Use `set -o pipefail`, read `PIPESTATUS`, or split the
  run from the check into separate steps.
- GitHub Actions' default shell is `bash -e {0}` - errexit, but **not**
  pipefail. `defaults: run: shell: bash` in the workflow switches it to
  `bash --noprofile --norc -eo pipefail {0}`, which this repo sets.
- `grep -c` prints `0` **and** exits 1, so `grep -c x f || echo 0` emits
  `0\n0` and breaks a numeric test.

Check the exit code of the thing you actually care about.

**Nothing is proven about the native stack until it is invoked.** LFS,
model hash, CUDA skip and tracing globs are all build-time checks that
pass without loading a single native symbol. `/api/health-onnx` (gated
behind `ENABLE_ONNX_HEALTH`) is what actually proves it.

**`vercel --prod` is not a reproducible build - it uploads your local
working tree.** There is no `.vercelignore`, so a CLI deploy ships
whatever is on disk, including `packages/*/dist` that `.gitignore` keeps
out of the repository. Every CLI deployment therefore built against
artifacts from one laptop, and looked perfectly healthy doing it. A Git
deployment clones only what is committed, so it is the only honest test
of whether the repository can build itself.

**The Vercel Root Directory is `apps/web`, so the build command runs
there, not at the monorepo root.** `pnpm build` in `apps/web` is
`next build` - it never runs Turbo, so the four `@pps/*` workspace
packages are never compiled and `next build` cannot resolve them from a
clean clone. `vercel.json` therefore builds through the dependency graph
Turbo already declares (`"build": {"dependsOn": ["^build"]}`):

    cd ../.. && pnpm turbo run build --filter=@pps/web...

The trailing `...` is load-bearing - it means "and everything @pps/web
depends on". Without it Turbo builds only the app and the clean clone
fails exactly as before. Do not simplify this back to `pnpm build`.
