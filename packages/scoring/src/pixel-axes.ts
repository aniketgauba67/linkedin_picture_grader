/**
 * The structural subset of `@pps/schema`'s `ComputedFeatures` that
 * scoring reads.
 *
 * Declared here rather than imported because this package must keep an
 * empty `dependencies` object - it runs in Deno and the browser, which
 * rules out zod. `ComputedFeatures` is a superset and is assignable to
 * this; `@pps/schema`'s test suite asserts that in both directions, so
 * the two cannot drift.
 */
export interface PixelFeatures {
  readonly width: number;
  readonly height: number;
  readonly sharpnessLaplacian: number;
  /** Null means unmeasurable, never "measured as zero". */
  readonly sharpnessEyeRegion: number | null;
  readonly eyeRegionMeasured: boolean;
  readonly jpegQualityEstimate: number;
  readonly exposureMean: number;
  readonly dynamicRange: number;
  /** Face-box lighting. The whole-frame fields above are diagnostic now:
   *  a backlit portrait looks correctly exposed on the frame and is a
   *  silhouette on the face, and the axis has to score the face. */
  readonly faceExposureMean: number;
  readonly faceClippedHighlights: number;
  readonly faceClippedShadows: number;
  readonly faceRegionMeasured: boolean;
  readonly clippedHighlights: number;
  readonly clippedShadows: number;
  readonly faceAreaRatio: number;
  readonly faceCenterOffsetX: number;
  readonly faceCenterOffsetY: number;
  readonly faceCount: number;
  readonly extractorVersion: string;
}

/**
 * A feature vector that has been through `assertFeaturesUsable` in
 * @pps/schema. Mirrored structurally - a string-literal brand rather
 * than a unique symbol - because this package cannot import that one.
 *
 * `score()` takes this type, so the guard having run is proved by the
 * compiler rather than assumed. The alternative was re-implementing the
 * validation here, which would give two implementations of one contract.
 */
export type ValidatedPixelFeatures = PixelFeatures & {
  readonly __validated: 'assertFeaturesUsable';
};

/** Magnitude of the signed face offset, as a fraction of the frame. */
export function faceCenterOffset(features: PixelFeatures): number {
  return Math.hypot(features.faceCenterOffsetX, features.faceCenterOffsetY);
}
