import type { Knot } from '../isotonic.js';

/**
 * Hand-set calibration. Prompt 11 refits the knots from labelled data
 * and overwrites this file.
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
    // Calibrated against the 1024px analysis plane. Changing
    // ANALYSIS_EDGE invalidates every one of these.
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
    // Usable luma span out of 255.
    lighting: [
      [0, 1],
      [80, 2],
      [130, 3],
      [170, 4],
      [205, 5],
    ],
    // Megapixels. LinkedIn renders at 400px, but crops need headroom.
    resolution: [
      [0, 1],
      [0.15, 2],
      [0.4, 3],
      [1.0, 4],
      [2.0, 5],
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
