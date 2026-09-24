# training

Empty for now.

This is where the distillation work will live: taking the vision model's
verdicts on the four judged axes (`background`, `attire`, `expression`,
`solo`) and training a local model that reproduces them.

Two constraints that shape anything put here:

- `data/` and `models/` are gitignored. No images are ever committed.
- Retraining must never require re-running extraction. Training reads the
  cached feature vectors out of `image_features`; it does not decode
  images. If a change here needs a new measurement, that is a
  `FEATURE_VECTOR_VERSION` bump in `@pps/schema` and a re-extraction pass,
  which is a deliberate and expensive decision.

The context weights in `@pps/scoring` are hand-set constants and are not in
scope for training. They are never learned.
