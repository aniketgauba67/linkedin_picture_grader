/**
 * @pps/eval - does the scoring agree with people?
 *
 * Every other test in this repo asks whether the code does what it says.
 * This package asks whether what it says is right, which no amount of
 * unit testing can answer.
 *
 * Zero dependencies, and zero workspace dependencies too: it reads axis
 * names out of the labels file rather than importing them from
 * @pps/schema, so it works unchanged on an experimental axis that the
 * schema has never heard of.
 */

export {
  agreement,
  alphaVerdict,
  bias,
  exactAgreement,
  insufficient,
  kendallTau,
  krippendorffAlpha,
  mae,
  measured,
  pairwiseAccuracy,
  spearman,
  withinOne,
  type Agreement,
  type AlphaVerdict,
  type Insufficient,
  type Measured,
  type Metric,
  type Rating,
} from './metrics.js';

export {
  nestedCV,
  phashDedup,
  splitByCluster,
  type DedupResult,
  type InnerFold,
  type OuterFold,
  type Split,
} from './split.js';

export {
  axisDistribution,
  compositeHistogram,
  confusionMatrix,
  renderConfusion,
  renderDistribution,
  renderHistogram,
  renderVariance,
  varianceContribution,
  DEAD_WEIGHT_SHARE,
  DEFAULT_LEVELS,
  DOMINANT_LEVEL_SHARE,
  MIN_RATINGS_FOR_DISTRIBUTION,
  RARE_LEVEL_SHARE,
  type AxisDistribution,
  type Confusion,
  type Histogram,
  type HistogramBin,
  type LevelShare,
  type VarianceShare,
} from './report.js';

export {
  ceilingVerdict,
  renderCeiling,
  reportCeiling,
  DEFAULT_CEILING_MARGIN,
  type CeilingReport,
  type CeilingRow,
  type CeilingVerdict,
} from './ceiling.js';

export {
  alignById,
  parseLabelsJsonl,
  ratingsByUnit,
  type AlignedAxis,
  type Alignment,
  type LabelRecord,
  type ParsedLabels,
} from './labels.js';

export { runCli, type CliResult, type ReadTextFile } from './cli.js';
