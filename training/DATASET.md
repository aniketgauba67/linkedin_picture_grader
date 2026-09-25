# Offline dataset pipeline

This prepares image data. It does not fit maps, alter production scoring,
or use the VLM as ground truth for sharpness, lighting, resolution or
framing. Run commands from the repository root. No VLM request is made
unless `--vlm` is explicitly supplied.

```sh
pnpm dataset bootstrap --out data/dataset-v1
pnpm dataset ingest --source data/new-batch.jsonl --out data/dataset-v1
pnpm dataset report --out data/dataset-v1
pnpm dataset candidates --out data/dataset-v1 --limit 100
```

`bootstrap` imports the existing 125 Wikimedia images as `development`,
with all 500 human computed-axis ratings unchanged. It also imports the
40 Pexels framing ratings as a **different cohort**. There is no merge
of their label scales. The source images, original label CSVs, and old
feature JSON/JSONL files are read, verified, and left untouched. The
new dataset lives in a gitignored directory under `data/`; back it up
deliberately before any large run.

## Source manifest

`ingest` reads one JSON object per line. Example for a local import:

```json
{"image_id":"new-0001","file_path":"incoming/new-0001.jpg","source":"licensed collection","source_url":"https://example.org/photo/1","creator":"Example Photographer","license":"CC BY 4.0","license_url":"https://creativecommons.org/licenses/by/4.0/","dataset_role":"development","cohort":"new_batch_1","source_group":null,"creator_group":null,"declared_mime_type":"image/jpeg"}
```

`file_path` is relative to the source JSONL's directory. For a remote
import, replace it with `download_url` and pass `--allow-download`;
only HTTPS is accepted. `source_url` is the provenance page, while
`download_url` is the actual image-byte endpoint. The declared MIME is
checked against JPEG/PNG/WebP magic bytes. Original bytes are copied
unchanged into `images/<sha256>.<extension>` and hashed before any
normalization. The production `extractAll` applies EXIF orientation
and produces the canonical `v7` feature vector. A source with a
different or malformed cached vector fails instead of being silently
accepted. The product's 200 px oriented shorter-edge rule is recorded
as eligibility; it never deletes an image or changes a human label.

Choose `dataset_role` **before fitting**: `development`, `validation`,
or `final_test`. The existing seed and framing cohorts remain
`development`; moving old images into `final_test` cannot make them
untouched. A source manifest must give stable `image_id` and `cohort`
values. The importer will not silently change an existing image's
hash, role, cohort, source group or creator group.

## Stored artifacts and provenance

- `manifest.jsonl` has one row per image ID. Its `file_path` is relative
  to the dataset directory. It records provenance, original-byte SHA,
  64-bit perceptual hash, role/cohort, `split_group`, oriented dimensions,
  MIME, extractor version, feature/VLM/human-label statuses, and product
  eligibility. `duplicate_of` records an earlier exact-byte match.
- `features/<sha256>.<extractor_version>.json` contains the canonical
  extracted vector. This is the expensive global-by-content cache.
  Two image IDs may point to the same vector while remaining separate
  manifest rows.
- `human-labels.jsonl` contains `source: "human"`, image ID, axis, 1–5
  score, cohort and rater. It supports all eight axes so later human
  audits of VLM judgments can coexist with VLM predictions. A repeated
  human label with a different score is rejected, not overwritten.
- `assessments/<identity>.json` contains `source: "vlm"`, image ID,
  active model, a SHA-256 fingerprint of the canonical prompt and
  rubric schema, timestamp, and either the full judged assessment or
  a typed decline (including `model_refusal`). These are per-image
  predictions, never human ground truth. No-face and dimension-ineligible
  images have no assessment file.
- `failures.jsonl` records individual stage failures. Rerunning the
  source manifest retries failures while reusing valid features and
  active-model/rubric assessments. A model or rubric change naturally
  misses the old assessment identity and can be assessed again.

The optional `--vlm` mode calls the existing `judgePhoto` and rubric;
it never requests sharpness, lighting, resolution or framing labels
from the model. Feature processing defaults to two concurrent images;
VLM calls default to one at a time. Both may be set with
`--concurrency N` and `--vlm-concurrency N` (1–8). Use one dataset
writer process at a time; local JSONL writes are atomic, but there is
no cross-process lock. A failed image does not stop the remaining batch.

## Experimental eight-axis offline labels

The separate `offline-label` command uses the production semantic-axis
rubric plus a versioned **offline-only** technical-axis rubric. It never
changes the production computed axes or human calibration labels. The
image ID, original-byte SHA, active model, rubric version and rubric
fingerprint identify a reusable result in `offline-eight-assessments/`.
An assessed result has eight VLM-sourced scores; no-face, model refusal
and other declines have no fabricated axis scores. The command skips
images below the product dimension floor and images whose extracted
`faceCount` is zero. Individual failures remain retryable on a later run.

```sh
pnpm offline-label run --cohort wikimedia_seed_125 --out data/dataset-v1 --max-new 10
pnpm offline-label validate --out data/dataset-v1
```

The second command is read-only. It compares eligible paired seed
images with their original human labels on sharpness, lighting,
resolution and framing; it reports rank agreement, absolute error,
bias, confusion matrices and large disagreements. Review this gate
before running the labeler on a new cohort. `--concurrency` defaults to
one VLM request at a time; use one writer process at a time. These VLM
predictions are pseudo-labels, never human ground truth.

## Leakage and coverage

SHA detects exact-byte duplicates. An EXIF-oriented 64-bit difference
hash flags likely resized or lightly edited variants at Hamming
distance at most six. It is a **review flag**, not proof that two
people or photographs are identical; aggressive crops can escape it.
The `split_group` is a connected component over exact matches, likely
near matches, shared source group and shared known creator group. A
cross-role group is rejected. `source_group` defaults to the provenance
page; `creator_group` defaults to a normalized credited creator, with
unknown/anonymous placeholders left ungrouped. Person identity is not
inferred. Review source and near-duplicate flags before locking a new
validation or final-test assignment.

`report` is read-only and prints category counts plus min, p10, p25,
median, p75, p90 and max for dimensions, face geometry, sharpness,
lighting, and `framingRaw`. It reports available paired VLM scores
without creating any. `candidates` is also read-only: it ranks
**development** images missing at least one computed-axis human label
by regions sparse in the existing human labels and flags extreme
values, no-face and multi-face cases. It outputs image IDs and the
specific `axes_to_label` for manual review, never labels or fitted
thresholds. The framing-only Pexels cohort remains a separate source
and may be selected for its three unlabeled computed axes. Neither
command reads `final_test` labels to choose model parameters.
