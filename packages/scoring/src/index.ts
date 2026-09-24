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

export { faceCenterOffset } from './pixel-axes.js';
export type { PixelFeatures, ValidatedPixelFeatures } from './pixel-axes.js';

export { MAX_FIXES, SEVERITY_THRESHOLDS, buildFixes, severityFor } from './fixes.js';
export type { Fix, FixSeverity } from './fixes.js';

export { computeConfidence, subjectDisagreement } from './confidence.js';
export type { ConfidenceContext, ConfidenceInputs } from './confidence.js';

export { KnotError, applyIsotonic, assertKnots } from './isotonic.js';
export type { Knot } from './isotonic.js';

export { WEIGHTS_V1 } from './weights/v1.js';
export type { AxisMaps, Weights } from './weights/v1.js';

export {
  bandPenalty,
  computeAxisScores,
  computeComputedAxes,
  framingRaw,
  lightingRaw,
  shorterEdge,
  framingScore,
  lightingScore,
  resolutionScore,
  sharpnessBasis,
  sharpnessScore,
} from './compute.js';
export type { ComputedAxisScores, JudgedScores } from './compute.js';

export {
  WeightsVersionError,
  axisBreakdown,
  composeScore,
  meanToComposite,
  score,
  weightedMean,
} from './score.js';
export type { AxisBreakdown, Coverage, ScoreInput, ScoreResultShape } from './score.js';

export { roundTo } from './composite.js';
