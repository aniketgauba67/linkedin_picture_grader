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
  version: '2026-09-24.1',
  compatibleExtractorVersion: 'v5',

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
     * Over `lightingRaw` (1 = ideal, approaching 0 = worst), NOT over
     * dynamicRange.
     *
     * THE DOMAIN CHANGED. These used to be luma-span values out of 255;
     * lightingRaw is a ratio in (0, 1]. A knot table left in the old
     * units does not fail, it clamps every photograph to the first knot
     * and hands out a flat score of 1 - which is exactly what the test
     * suite caught when the domain moved and this table had not.
     *
     * Provisional until the refit lands.
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
    // Over framingRaw (1 = ideal, 0 = worst). Monotone in goodness.
    framing: [
      [0, 1],
      [0.35, 2],
      [0.6, 3],
      [0.8, 4],
      [0.95, 5],
    ],
  },

  framing: {
    idealRatioMin: 0.25,
    idealRatioMax: 0.35,
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
