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