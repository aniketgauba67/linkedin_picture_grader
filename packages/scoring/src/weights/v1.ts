import type { Knot } from '../isotonic.js';

/**
 * PROVISIONAL. DO NOT HAND-TUNE THESE NUMBERS - THEY GET FITTED.
 *
 * Every knot below is an old step-ladder threshold re-expressed as a
 * knot. Not one of them has been validated against labelled data, and no
 * individual value should be treated as meaningful: they are a shape to
 * start from, not a calibration.
 *
 * The change from stepped thresholds to linear interpolation is
 * deliberate and right in direction - a score should move continuously
 * with the measurement rather than jumping at an arbitrary boundary -
 * but it also means the boundary behaviour is now different from
 * anything that was ever tested, in a way nobody has measured.
 *
 * Prompt 11 replaces this file wholesale from fitted data. Adjusting a
 * number here by hand buys a local improvement on whatever photo
 * prompted it and silently costs accuracy everywhere else, which is the
 * failure mode calibration exists to prevent.
 *
 * Prompt 11 refits the knots from labelled data and overwrites this file.
 *
 * A .ts module rather than JSON on purpose: this package has to load
 * unchanged in Node, Deno and the browser, and JSON import attributes
 * still resolve differently across those three. The training step writes
 * this file; a test asserts it satisfies the expected shape.
 */
export interface AxisMaps {
  /** Whole-frame Laplacian variance. Fitted on the whole corpus. */
  readonly sharpnessFrame: readonly Knot[];
  /** Eye-region Laplacian variance. Fitted only where a face was found. */
  readonly sharpnessEyeRegion: readonly Knot[];
  readonly lighting: readonly Knot[];
  readonly resolution: readonly Knot[];
  /**
   * Fitted over `framingRaw`, NOT over faceAreaRatio.
   *
   * Framing has a two-sided optimum - a face can be too large as well as
   * too small - and an isotonic map is monotone by construction, so it
   * cannot represent that. pixel-axes.ts reduces the ratio and the
   * centre offset to a single one-sided badness scalar first; this map
   * runs over that. Fitting it over faceAreaRatio directly would silently
   * lose the upper penalty.
   */
  readonly framing: readonly Knot[];
}

export interface Weights {
  /** Bumped when a number in this file changes. */
  readonly version: string;
  /**
   * The extractor these knots were fitted against. Separate from
   * `version`: a retune and a feature-shape change are different events,
   * and collapsing them would force a re-extraction on every retune.
   */
  readonly compatibleExtractorVersion: string;
  readonly maps: AxisMaps;
  readonly framing: {
    /** Face area as a fraction of frame. Inside this band, no penalty. */
    readonly idealRatioMin: number;
    readonly idealRatioMax: number;
    /** Centre offset below this is free. */
    readonly offsetTolerance: number;
    /** How fast each penalty grows once outside its tolerance. */
    readonly ratioPenaltyScale: number;
    readonly offsetPenaltyScale: number;
  };
  readonly lighting: {
    /** Mean luma has an ideal middle; outside it is under/over-exposed. */
    readonly idealExposureMin: number;
    readonly idealExposureMax: number;
    readonly exposurePenaltyScale: number;
    /** Total clipped fraction that costs a full point. */
    readonly clippingFullPenaltyAt: number;
  };
  /** Below this, block artifacts inflate the sharpness measurement. */
  readonly jpegQualityFloor: number;
}

export const WEIGHTS_V1: Weights = {
  version: '2026-09-24.2',
  compatibleExtractorVersion: 'v7',

  maps: {
    /**
     * UNFITTED. Still the original hand-set ladder.
     *
     * The 125-image calibration set could not fit either sharpness map.
     * The frame basis had 20 usable images and a cross-validated
     * Spearman of -0.005 - no signal at all - and the eye-region basis
     * reached 0.248 and topped out at 3.
     *
     * The cause is the corpus, not the measurement: Commons thumbnails
     * at a median 0.15MP have neither the range nor the detail to
     * separate genuinely sharp from genuinely blurred. Fitting these
     * needs native-resolution photographs, 2MP and up, spanning both
     * ends - which is the Pexels collection, not this set.
     *
     * Calibrated against the 1024px analysis plane. Changing
     * ANALYSIS_EDGE invalidates every one of these.
     */
    sharpnessFrame: [
      [0, 1],
      [40, 2],
      [120, 3],
      [300, 4],
      [700, 5],
    ],
    // Provisional: mirrors the frame map because there is no labelled
    // eye-region data yet. Kept as a separate constant so that fitting
    // one in Prompt 11 cannot move the other.
    sharpnessEyeRegion: [
      [0, 1],
      [40, 2],
      [120, 3],
      [300, 4],
      [700, 5],
    ],
    /**
     * HAND-SET RULE, NOT A FIT. This is a clipping-and-exposure sanity
     * check, not a lighting quality model, and it should not be
     * described as one anywhere.
     *
     * Mean facial exposure was tested properly against the 125-image
     * labelled set and rejected. The numbers are in
     * docs/calibration-notes.md; the short version is that the best
     * held-out Spearman achievable by ANY two-sided mean-exposure
     * scalar is 0.335, found by searching every centre from 60 to 180,
     * and the band below is already at the optimum centre of 130. The
     * measurement is not mis-tuned. It is insufficient.
     *
     * What it does catch, and what it is kept for: a face that is
     * genuinely crushed to black or blown to white. That is a real
     * defect and a real floor, and it is worth the weight it now
     * carries - which is roughly half what it used to, precisely
     * because an axis nobody can validate should not vote like one that
     * has been.
     *
     * Do not fit this. Do not widen it to chase a correlation. Lighting
     * quality needs directional features - key/fill ratio, shadow
     * gradient across the face, highlight rolloff - and may belong with
     * the VLM-judged axes rather than the computed ones.
     *
     * Over `lightingRaw` (1 = ideal, approaching 0 = worst), NOT over
     * dynamicRange. THE DOMAIN CHANGED when lightingRaw replaced it:
     * these used to be luma-span values out of 255. A knot table left
     * in the old units does not fail, it clamps every photograph to the
     * first knot and hands out a flat score of 1.
     */
    lighting: [
      [0, 1],
      [0.35, 2],
      [0.6, 3],
      [0.8, 4],
      [0.95, 5],
    ],
    /**
     * SPEC-DERIVED, NOT FITTED. Do not learn this map.
     *
     * Shorter edge in pixels, against LinkedIn's published requirement:
     * minimum 400x400, recommended 800x800, maximum 7680x4320 / 8MB.
     * Below 200px is under their floor; 400 meets the minimum but is
     * soft on a retina display; 800 is the recommendation and nothing
     * above it helps, because LinkedIn downscales to its own render
     * size regardless.
     *
     * The shorter edge rather than megapixels, because a square avatar
     * crop is limited by the short side: a 4000x400 panorama is 1.6
     * megapixels and 400 usable pixels.
     *
     * An attempt to fit this against the 125-image calibration set
     * produced a map topping out at 4 - no labelled photograph was
     * large enough to earn a 5 - which would have capped every real
     * upload from 1.4MP to 40MP at 4 forever. A published requirement
     * is not a matter of taste and there is nothing here to learn.
     */
    resolution: [
      [200, 1],
      [400, 3],
      [800, 5],
    ],
    /**
     * PROVISIONAL, HAND-SET, SPANNING THE FULL 1-5. Reverted from a fit.
     *
     * A fitted map shipped here briefly and was withdrawn. It was valid
     * only to score 2 - the 125 labels never reached 4 or 5 - and
     * applyIsotonic clamps above the last knot, so it handed 2 to every
     * well-framed photograph in existence. Across the 150-image corpus
     * it produced a 0.31-point range on a 1-5 axis, with 64 images
     * pinned at exactly 2.00. It had disabled the axis in production.
     *
     * A hand-set guess spanning the whole range beats a fitted map
     * spanning a fifth of it. This is the honest guess.
     *
     * There IS evidence the scalar works: fitted on 40 stratified
     * corpus photographs it reaches 5.00 with 0.797 cluster-held-out
     * (docs/calibration-notes.md). That map is not shipped, because the
     * same person labelled and fitted it - 0.797 measures a labeller's
     * self-consistency, not the model's accuracy.
     *
     * TODO: refit once a properly anchored corpus exists - two raters,
     * a shared overlap, and an alpha computed on it before any merge.
     * `pnpm --filter @pps/eval exec pps-eval overlap` enforces that.
     *
     * LEVEL-CALIBRATED against the 125-image human seed set. framingRaw
     * itself is unchanged; only these knots moved.
     *
     * The previous hand-set spacing [0.2,1] [0.4,2] [0.6,3] [0.78,4]
     * [0.92,5] ran roughly +1.39 high against human labels: it scored a
     * typical human-3 photograph as a 5, and awarded 45 fives over 117
     * images where humans awarded none. Group-aware 5-fold development
     * CV, current versus this table on identical held-out rows:
     *
     *   bias     +1.393 -> +0.444      MAE      1.427 -> 0.752
     *   exact     0.162 ->  0.470      within-1 0.530 -> 0.812
     *   Spearman  0.760 ->  0.757      Kendall  0.656 -> 0.652
     *
     * Ordering is preserved; only the levels moved, which is what the
     * evidence supported.
     *
     * KNOTS 1-3 ARE DATA-SUPPORTED: each sits at the median framingRaw
     * of the photographs humans labelled 1, 2 and 3.
     *
     * KNOTS 4 AND 5 ARE SPEC-PRESERVED, NOT LEARNED. framingRaw
     * saturates at 1.0 and 22 of 117 eligible images sit at exactly
     * 1.0, carrying ten human-3s and ten human-4s - two classes on one
     * value, which no threshold can separate. Human 5 has no examples
     * anywhere in the set. So knot 5 is the measurement ceiling (only
     * framing the measurement calls perfect earns a 5) and knot 4 is
     * midway between the human-3 median and that ceiling.
     *
     * Placing knot 4 at the human-4 median scores better on every level
     * metric (MAE 0.496) and makes level 5 UNREACHABLE, because the
     * human-4 median IS the ceiling. Refused deliberately: an axis that
     * cannot award its top score is the failure this file has already
     * shipped once and reverted.
     *
     * Development CV estimates, not test accuracy - these 125 images
     * have already influenced calibration here.
     */
    framing: [
      [0.4801, 1],
      [0.6697, 2],
      [0.934, 3],
      [0.967, 4],
      [1, 5],
    ],
  },

  framing: {
    /**
     * DERIVED FROM OBSERVATION, n=12. Not fitted, not guessed.
     *
     * The interquartile range of `faceAreaRatio` over the twelve corpus
     * photographs labelled 5 for framing by eye, before the measurement
     * was consulted. Median 0.150, full range 0.093-0.306.
     *
     * It replaces a hand-set 0.25-0.35, which was wrong in a way that
     * disabled half the axis: only 1 of those 40 labelled photographs
     * sat above 0.25 at all, so the "face too large" side of the
     * two-sided penalty never fired, while genuinely well-framed
     * portraits were charged for being too small.
     *
     * The old number probably came from LinkedIn's ~60% facial coverage
     * guidance, which is a DIFFERENT DENOMINATOR: that figure is
     * measured after their circular crop on a square image, and this
     * one is the SCRFD box over the full rectangular frame. A portrait
     * that fills 60% of a circular avatar covers far less of the
     * uncropped photograph it was cut from. Do not reconcile the two
     * numbers by adjusting this one to match; they measure different
     * things.
     */
    idealRatioMin: 0.1298,
    idealRatioMax: 0.2396,
    offsetTolerance: 0.15,
    // A face at 0.12 - less than half the ideal floor - loses ~0.65.
    ratioPenaltyScale: 5,
    offsetPenaltyScale: 2,
  },

  lighting: {
    // Two-sided, for the same reason framing is: a photograph can be
    // over-exposed as well as under-exposed.
    idealExposureMin: 95,
    idealExposureMax: 165,
    exposurePenaltyScale: 0.012,
    clippingFullPenaltyAt: 0.08,
  },

  jpegQualityFloor: 50,
};
