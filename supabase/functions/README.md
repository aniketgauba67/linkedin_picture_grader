# Supabase Edge Functions

Deno. 256MB memory, 2s CPU, 20MB bundle, no `sharp`, no image decoding.

`score/` imports `@pps/scoring` through the import map in its `deno.json`,
which points at `packages/scoring/dist/index.js`. That means:

- **`pnpm build` must have run** before `supabase functions deploy score`.
- `@pps/scoring` has to keep its empty `dependencies`. Anything it imported
  would be pulled into this bundle and into this CPU budget.

Never add inference, image decoding, or a model load to a function here.
Extraction belongs in a Vercel Node function; this runtime only ever does
arithmetic on a vector that is already in Postgres.
