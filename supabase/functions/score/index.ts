/// <reference lib="deno.ns" />

import {
  computeConfidence,
  isContext,
  scoreComputedAxes,
  scorePhoto,
  type AxisScores,
  type PixelFeatures,
} from '@pps/scoring';

/**
 * Scoring, in the runtime it is designed for: 256MB of memory, a 2s CPU
 * budget, and a 20MB bundle. It imports @pps/scoring - which has zero
 * dependencies, by construction - and nothing else.
 *
 * What this function must never do: decode an image, load a model, or call
 * a vision API. It reads the ComputedFeatures vector that extraction
 * already cached, plus the Assessment that was already stored, and does a
 * dot product. That is roughly 3ms.
 *
 * It answers with an AnalysisOutcome. A decline is a 200 with
 * `status: "declined"`, not an error status - declining is a normal result
 * and every caller has to handle it.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

type DeclineReason =
  | 'no_face'
  | 'apparent_minor'
  | 'not_a_photo'
  | 'model_refusal'
  | 'corrupt_file';

interface FeatureRow {
  version: number;
  vector: Record<string, unknown>;
}

interface JudgedEntry {
  evidence: string;
  score: number;
}

interface VerdictRow {
  assessment: {
    background: JudgedEntry;
    attire: JudgedEntry;
    expression: JudgedEntry;
    solo: JudgedEntry;
    unscorable: boolean;
    unscorable_reason: string | null;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function declined(reason: DeclineReason, message: string): Response {
  return json({ status: 'declined', reason, message });
}

/**
 * The Edge runtime receives JSONB straight from Postgres, so every number
 * is unverified. @pps/schema's `assertFeaturesUsable` is the Node-side
 * guard; this is the same check, inlined, because pulling zod in here
 * would break the empty-dependencies rule the whole package rests on.
 *
 * A NaN reaching `scorePhoto` does not throw. It produces a
 * plausible-looking wrong score, which is the worst outcome available.
 */
function readFeature(vector: Record<string, unknown>, field: string): number {
  const value = vector[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Cached feature "${field}" is not a finite number`);
  }
  return value;
}

/**
 * `sharpnessEyeRegion` is the one measurement allowed to be null, which
 * means "unmeasurable" - no face, or a crop too small to convolve. It is
 * NOT a synonym for zero: a flat eye region really does measure zero and
 * must score as such rather than falling back to the whole frame.
 */
function readNullableFeature(vector: Record<string, unknown>, field: string): number | null {
  const value = vector[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Cached feature "${field}" is neither null nor a finite number`);
  }
  return value;
}

function readFlag(vector: Record<string, unknown>, field: string): boolean {
  const value = vector[field];
  if (typeof value !== 'boolean') {
    throw new TypeError(`Cached feature "${field}" is not a boolean`);
  }
  return value;
}

function readFeatures(vector: Record<string, unknown>): PixelFeatures & {
  yaw: number;
  pitch: number;
} {
  return {
    width: readFeature(vector, 'width'),
    height: readFeature(vector, 'height'),
    sharpnessLaplacian: readFeature(vector, 'sharpnessLaplacian'),
    sharpnessEyeRegion: readNullableFeature(vector, 'sharpnessEyeRegion'),
    eyeRegionMeasured: readFlag(vector, 'eyeRegionMeasured'),
    jpegQualityEstimate: readFeature(vector, 'jpegQualityEstimate'),
    dynamicRange: readFeature(vector, 'dynamicRange'),
    clippedHighlights: readFeature(vector, 'clippedHighlights'),
    clippedShadows: readFeature(vector, 'clippedShadows'),
    faceAreaRatio: readFeature(vector, 'faceAreaRatio'),
    faceCenterOffsetX: readFeature(vector, 'faceCenterOffsetX'),
    faceCenterOffsetY: readFeature(vector, 'faceCenterOffsetY'),
    faceCount: readFeature(vector, 'faceCount'),
    yaw: readFeature(vector, 'yaw'),
    pitch: readFeature(vector, 'pitch'),
  };
}

async function selectOne<T>(table: string, imageId: string, columns: string): Promise<T | null> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?image_id=eq.${imageId}&select=${columns}&limit=1`;
  const response = await fetch(url, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) {
    throw new Error(`${table} query failed with ${response.status}`);
  }
  const rows = (await response.json()) as T[];
  return rows[0] ?? null;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return json({ error: 'Use POST' }, 405);
  }

  let body: { imageId?: unknown; context?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const imageId = typeof body.imageId === 'string' ? body.imageId : '';
  if (imageId === '') {
    return json({ error: 'imageId is required' }, 400);
  }

  const rawContext = typeof body.context === 'string' ? body.context : 'corporate';
  if (!isContext(rawContext)) {
    return json({ error: `Unknown context ${rawContext}` }, 400);
  }

  const [features, verdict] = await Promise.all([
    selectOne<FeatureRow>('image_features', imageId, 'version,vector'),
    selectOne<VerdictRow>('vision_verdicts', imageId, 'assessment'),
  ]);

  // Not-yet-extracted is a pipeline state, not a decline: the image may
  // still score perfectly well once extraction has run. Extraction cannot
  // run here - sharp needs Node and this runtime decodes no images.
  if (features === null) {
    return json({ error: 'Features not extracted yet', imageId }, 409);
  }
  if (verdict === null) {
    return json({ error: 'Assessment not recorded yet', imageId }, 409);
  }

  let computed: ReturnType<typeof readFeatures>;
  try {
    computed = readFeatures(features.vector);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Cached features are unusable', imageId },
      422,
    );
  }

  if (computed.faceCount === 0) {
    return declined('no_face', 'No face was found in this image, so there is nothing to score.');
  }
  if (verdict.assessment.unscorable) {
    return declined(
      'not_a_photo',
      verdict.assessment.unscorable_reason ?? 'This image cannot be assessed as a profile photo.',
    );
  }

  const axes: AxisScores = {
    ...scoreComputedAxes(computed),
    background: verdict.assessment.background.score,
    attire: verdict.assessment.attire.score,
    expression: verdict.assessment.expression.score,
    solo: verdict.assessment.solo.score,
  };

  return json({
    status: 'scored',
    result: scorePhoto(axes, rawContext, { confidence: computeConfidence(computed) }),
  });
});
