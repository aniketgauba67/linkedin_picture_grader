# training

Corpus collection now; distillation later.

The resumable offline manifest, seed import, bounded VLM labeling, diversity
report, and human-review candidate commands are documented in
[DATASET.md](DATASET.md). They do not fit or change scoring weights.

Not a shipped package. It is a workspace member so it can import
`@pps/features` and be covered by the same typecheck, lint and test run as
everything else — nothing in `apps/` or `packages/` may depend on it.

## collect-corpus.ts

Builds the labelling corpus from [Pexels](https://www.pexels.com/api/).

The key comes from `.env.local`, loaded by `--env-file-if-exists` — no
dependency, and a missing file is a notice rather than a crash. An inline
value still wins, so either of these works:

```
pnpm corpus                                     # key from .env.local, 150 images
pnpm corpus -- --total 700
pnpm corpus -- --dry-run                        # fetch and extract, write nothing
PEXELS_API_KEY=... pnpm corpus                  # inline, overrides the file
```

Writes `data/images/<sha256>.jpg`, appends `data/manifest.csv`, and appends
the feature vector to `data/features.jsonl`.

**`data/manifest.csv` is the only committed file under `data/`.** It holds
no pixels — it is the record of where every image came from, under what
licence, and who took it. `.gitignore` uses `data/*` plus a negation
rather than `data/`, because git cannot re-include a file whose parent
directory is excluded. The same trap is documented for `models/`.

### Why the BAD queries exist

Stock photography is aspirational. Nobody tags an upload "blurry" or "bad
headshot", so a corpus pulled from the obvious queries lands almost
entirely in the 4–5 band and the 1–3 range comes back empty. A scorer
fitted on that has never seen the thing it exists to detect.

So 30% of the corpus comes from queries chosen to surface specific failure
modes: `car selfie` is a framing and background failure, `group of friends
photo` is a solo failure, `person sunglasses` is an expression failure with
the eyes removed.

`queryVariant` is **not a label**. It records which net caught the photo.
"professional headshot" returns plenty of badly lit photographs and the
scorer must be free to say so.

### Extraction runs immediately, on purpose

Every image goes through `extractAll()` the moment it lands, and a decode
failure or a non-finite measurement keeps it out of the manifest. Labelling
is the only irreversible spend in this pipeline; paying a vision model to
look at an image extraction cannot read is the waste this ordering avoids.
Failures are reported individually at the end, never counted and dropped,
and a run with any failure exits non-zero.

The vectors are written to `data/features.jsonl` as they are computed.
Extraction is ~800ms an image and the architecture rule is that retraining
must never re-run it, so throwing away 150 vectors we already have would be
the exact thing that rule forbids.

### Rate limits

`api.pexels.com` reports where you stand in `X-Ratelimit-Remaining` /
`X-Ratelimit-Reset`, and the client reads those off every response rather
than counting locally — a local counter is wrong the moment anything else
uses the same key, and it is wrong about the limit too. Pexels publishes
200/hour for the free tier; the key measured on 2026-09-24 reported
`X-Ratelimit-Limit: 25000` resetting roughly 30 days out. Whatever the
headers say is the truth.

A full 150-image collection costs **17 API requests** — one search per
query, since 80 results per page covers every target.

`images.pexels.com` is a CDN and not part of that quota, so downloads run
at a fixed small concurrency instead.

When the quota runs low the run **stops cleanly** and exits 3. The manifest
is appended per image, so re-running picks up exactly where it stopped.

## Later: distillation

Taking the vision model's verdicts on the four judged axes (`background`,
`attire`, `expression`, `solo`) and training a local model that reproduces
them.

Two constraints that shape anything put here:

- `data/` and `models/` are gitignored except for the two files named
  above. No images are ever committed.
- Retraining must never require re-running extraction. Training reads the
  cached feature vectors; it does not decode images. If a change here needs
  a new measurement, that is a `FEATURE_VECTOR_VERSION` bump in
  `@pps/schema` and a re-extraction pass — a deliberate and expensive
  decision.

The context weights in `@pps/scoring` are hand-set constants and are not in
scope for training. They are never learned.
