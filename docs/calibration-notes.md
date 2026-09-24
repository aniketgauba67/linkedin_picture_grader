# Calibration notes

What was fitted, what was not, and what was tried and rejected. The
rejections are the point of this file: without them the same idea gets
proposed again in three weeks, costs another week, and fails the same
way.

The calibration set is the 125 hand-labelled Wikimedia photographs in
`data/validation/` — 40 GOOD / 45 MEDIUM / 40 BAD, 500 labels across
`sharpness`, `lighting`, `resolution` and `framing`. It is disjoint from
the Pexels training corpus by sha256 and off-limits to `training/fit.ts`
(see `training/paths.ts`).

Every held-out figure below is cluster-held-out by credited photographer,
not by image. In-sample figures are reported alongside because the gap
between them is the whole reason to compute both.

---

## REJECTED — mean facial exposure as a lighting quality model

**Do not propose this again without new features.** It has been tested
properly and it does not work.

| scalar | held-out Spearman |
| --- | --- |
| whole-frame `exposureMean` | **−0.070** |
| face-box `faceExposureMean` | **+0.188** |
| best two-sided band, centre searched 60→180 | **0.335** |

Three separate findings, in order:

1. **The frame was the wrong region.** Whole-frame exposure correlates
   *negatively* with the human lighting label. That is the backlit case:
   a bright window fills the frame histogram while the subject is a
   silhouette, so the frame says "well lit" on exactly the photographs
   where lighting is worst. Fitting over `dynamicRange` produced a
   single-knot map — one constant output for every input.

2. **Moving to the face fixed the sign, not the problem.** `lightingRaw`
   over the face box has a healthy distribution (119 distinct values
   over 125 images, no value holding more than 5.6%) and is genuinely
   fittable. Held-out Spearman is 0.204.

3. **The ceiling is the measurement, not the tuning.** Searching every
   two-sided band centre from 60 to 180 tops out at 0.335, at centre
   130 — which is where the shipped band (95–165) already sits. The band
   is not mis-tuned. A mean cannot express what people mean by lighting
   on a portrait.

Face clipping contributes almost nothing on its own (0.026).

### What ships instead

The 95–165 band, kept as a **clipping-and-exposure sanity check, not a
lighting quality model**. It catches a face crushed to black or blown to
white, which is a real defect, and nothing more is claimed for it. Its
context weight was roughly halved for that reason —
`WEIGHTS_VERSION 2026-09-24.2`.

### What lighting would actually need

Directional features, none of which exist today:

- key/fill ratio across the face
- shadow gradient — is the falloff smooth or a hard edge?
- highlight rolloff on the forehead and cheekbones

This may not belong among the computed axes at all. "Is this lit well?"
is closer to the judgement the VLM axes already make than to a pixel
statistic, and moving it there is a live option rather than a fallback.

`exposureDelta` (`exposureMean − faceExposureMean`) is extracted and
cached as TIER 2 against that revisit. It is the backlight signature —
bright frame, dark face — and it is the one directional signal available
without new measurement. Nothing reads it at scoring time.

---

## SHIPPED — framing

Held-out Spearman **0.595** (in-sample 0.698), over `framingRaw`.

> An earlier run reported 0.681. That figure predates a fix to the
> cluster keys: placeholder credits were being matched exactly, so
> "Unknown author" ×4 and "Not stated on source page" ×2 were pooled
> into two invented clusters and held out together. Correcting that
> changed 114 clusters to 118 and the held-out figure to 0.595. The
> lower number is the right one; 0.681 was leakage across a cluster
> boundary that did not exist.

The map was unfittable until the scalar was fixed. `framingRaw` used to
be `clamp01(1 - (ratioPenalty + offsetPenalty))`, which returns exactly
0 once the penalties sum past 1 — **53 of 125 images on a single value,
carrying human labels from 1 to 4**. A monotone fit cannot separate
points that share an x, so 42% of the set carried no information
whatever it was labelled.

It is now `1 / (1 + ratioPenalty + offsetPenalty)`: strictly decreasing
over the whole unbounded penalty range, bounded in (0, 1], never
saturating. Pile-up 42% → 16%, distinct values 58 → 91, held-out
Spearman 0.572 → 0.595 on correct clusters. The residual 16% is the
`faceCount == 0` floor, which is a real category rather than an
artifact.

### The ceiling, and why it shipped anyway

**The fitted map is valid to score 2 and extrapolates above it.** No
photograph in the set was labelled 5 on framing and only 12 were
labelled 4, so the fit has nothing to anchor the top of the scale.

This is a label-coverage problem, not a measurement one, and it is the
one ceiling in this whole exercise that more images genuinely fix — the
Pexels corpus is full of well-framed portraits and none of them are
labelled yet. Shipping a real fit over the range the data supports beats
keeping a hand-set guess across the whole range.

**TODO:** refit once labelled well-framed examples exist. Anything
scoring above 2 on framing today is extrapolation.

---

## NOT FITTED — resolution

Spec-derived from LinkedIn's published requirement: minimum 400×400,
recommended 800×800. Shorter edge, not megapixels, because a square
avatar crop is limited by the short side — a 4000×400 panorama is 1.6MP
and 400 usable pixels.

Fitting it was tried and rejected: no photograph in the set was large
enough to earn a 5, so the fitted map topped out at 4 and would have
capped every real upload from 1.4MP to 40MP at 4 forever. 44% of the
validation set sits at exactly 330px on the shorter edge, which is a
Commons thumbnail artifact and not a distribution anything should learn
from.

A published requirement is not a matter of taste. There is nothing here
to learn.

---

## NOT FITTED — sharpness, both maps

| map | n | held-out Spearman | top knot |
| --- | --- | --- | --- |
| `sharpnessEyeRegion` | 105 | 0.248 | 3.00 |
| `sharpnessFrame` | 20 | −0.005 | 3.00 |

Left on the original hand-set ladder, labelled unfitted in
`weights/v1.ts`.

The cause is the corpus, not the measurement. Commons thumbnails at a
median 0.15MP have neither the range nor the detail to separate
genuinely sharp from genuinely blurred, and the frame basis had 20
usable images to fit on. This needs native-resolution photographs, 2MP
and up, spanning both ends — which is the Pexels collection, not this
set.

---

## Standing checks

Every raw scalar prints its distribution on every calibration run,
fitted or not, and warns when one value holds more than 10% of the data.
A pile-up is unfittable and it is invisible in a correlation, a knot
table, or any other number the report prints. The framing pile-up sat
through an entire calibration run unnoticed before this check existed.

`calibrate.ts` exits 2 and writes nothing when a fitted map tops out
below 4, collapses to a single knot, or has a held-out Spearman under
0.3. Getting past that requires `--override-stop "<reason>"`, and the
reason is written into the weights file next to the knots it excused.
