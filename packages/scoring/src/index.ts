/**
 * @pps/scoring - pure, dependency-free scoring.
 *
 * Runs unchanged in Node, Deno (Supabase Edge Functions) and the browser.
 * Every export is a pure function over plain data: no I/O, no image
 * decoding, no model inference.
 *
 * The types here mirror `@pps/schema` by name. They are mirrored rather
 * than imported because this package keeps an empty `dependencies` object
 * - zod cannot come with it into a 20MB Deno bundle. `@pps/schema`'s test
 * suite asserts the two agree, so a change to one fails the build of the
 * other.
 */
export {
  AXES,
  AXIS_DESCRIPTIONS,
  AXIS_MAX,
  AXIS_MIN,
  COMPOSITE_MAX,
  COMPOSITE_MIN,
  COMPUTED_AXES,
  JUDGED_AXES,
  isAxis,
  normalizeAxisScore,
} from './axes.js';
export type { AxisName, AxisScores, ComputedAxisName, JudgedAxisName } from './axes.js';

export {
  CONTEXTS,
  CONTEXT_WEIGHTS,
  DEFAULT_CONTEXT,
  WEIGHTS_VERSION,
  isContext,
  weightSum,
  weightsFor,
} from './weights.js';
export type { AxisWeights, Context } from './weights.js';

export {
  JPEG_QUALITY_FLOOR,
  PIXEL_THRESHOLDS,
  faceCenterOffset,
  framingScore,
  lightingScore,
  resolutionScore,
  scoreAgainstThresholds,
  scoreComputedAxes,
  sharpnessScore,
} from './pixel-axes.js';
export type { PixelFeatures } from './pixel-axes.js';

export { FIX_MESSAGES, MAX_FIXES, SEVERITY_THRESHOLDS, severityFor } from './fixes.js';
export type { Fix, FixSeverity } from './fixes.js';

export { computeConfidence } from './confidence.js';
export type { ConfidenceInputs } from './confidence.js';

export {
  axisBreakdown,
  buildFixes,
  meanToComposite,
  roundTo,
  scorePhoto,
  weightedMean,
} from './composite.js';
export type { AxisBreakdown, ScoreOptions, ScoreResultShape } from './composite.js';
