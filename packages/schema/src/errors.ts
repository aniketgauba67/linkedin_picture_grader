/**
 * Raised when a feature vector and a weights table disagree about which
 * extractor produced the numbers.
 *
 * A retune and a feature-shape change are different events. WEIGHTS
 * version moves when a threshold is refitted; EXTRACTOR version moves
 * when a measurement's meaning changes. The weights therefore carry a
 * third field saying which extractor they were fitted against, and a
 * mismatch is fatal rather than a warning: the map would be applied to
 * numbers that mean something else and produce a confident wrong score.
 */
export class WeightsVersionError extends Error {
  readonly featuresExtractorVersion: string;
  readonly weightsCompatibleWith: string;

  constructor(featuresExtractorVersion: string, weightsCompatibleWith: string) {
    super(
      `Weights were fitted against extractor ${weightsCompatibleWith}, ` +
        `but these features came from ${featuresExtractorVersion}. ` +
        'Re-extract, or load weights fitted against this extractor.',
    );
    this.name = 'WeightsVersionError';
    this.featuresExtractorVersion = featuresExtractorVersion;
    this.weightsCompatibleWith = weightsCompatibleWith;
  }
}
