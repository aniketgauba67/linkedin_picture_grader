/// <reference lib="deno.ns" />

import {
  computeConfidence,
  isContext,
  score,
  WEIGHTS_V1,
  type ScoreInput,
  type ScoreResultShape,
} from '@pps/scoring';
import {
  ACTIVE_VLM_MODEL,
  ComputedFeatures,
  MIN_IMAGE_SHORT_EDGE_PX,
  assertFeaturesUsable,
  belowDimensionFloor,
  type ValidatedFeatures,
} from '@pps/schema';

/**
 * Scoring, in the runtime it is designed for: 256MB of memory, a 2s CPU
 * budget, and a 20MB bundle. It imports pure @pps/scoring and the
 * canonical @pps/schema feature validator.
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

type DeclineReason = NonNullable<ScoreInput['declined']>;

interface FeatureRow {
  computed: unknown;
  extractor_version: string;
}

interface AssessmentRow {
  axes: unknown;
}

type Verdict =
  | { status: 'assessed'; assessment: NonNullable<ScoreInput['judged']> }
  | { status: 'declined'; reason: Exclude<DeclineReason, 'corrupt_file'>; detail: string };

/**
 * CORS. The browser calls this function directly, cross-origin, and
 * without these headers it cannot reach it at all.
 *
 * This was invisible to every test written before a real browser ran
 * the flow: Node's `fetch` does not enforce CORS, so the whole path
 * passed from a script and failed with "Failed to fetch" from a page.
 * The preflight answered 405 because the handler only accepted POST.
 *
 * `authorization` and `apikey` are listed because Supabase Edge
 * invocation sends both, and a header absent from this list fails the
 * preflight even when the method is allowed.
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * An internal failure, told to the caller as a fixed string and to the
 * logs in full.
 *
 * This function answers unauthenticated browser callers by design
 * (`verify_jwt = false` in config.toml), so a raw `error.message` here
 * is PostgREST's or zod's internal text handed to anyone who asks -
 * constraint names, column names, row shapes. The Next.js routes
 * already log-and-sanitize; this brings the Edge boundary in line.
 *
 * The detail goes to the Supabase function logs, which is where it is
 * useful and where only we can read it.
 */
function internalFailure(stage: string, error: unknown, status = 502): Response {
  console.error(`[score] ${stage}`, error);
  return json({ error: 'Scoring failed.' }, status);
}

/**
 * A decline carries the score the photograph earned anyway.
 *
 * `corrupt_file` is the one reason with no score, because the bytes
 * never decoded and there is nothing to have measured. Every other
 * reason ran extraction first, so there is a real capped number and
 * withholding it leaves the user with nothing to act on.
 */
function declined(reason: DeclineReason, message: string, result: ScoreResultShape): Response {
  return json({ status: 'declined', reason, message, score: result });
}

/** The Edge function uses PostgREST directly to keep its bundle small. */
async function selectOne<T>(table: string, filters: Record<string, string>, columns: string): Promise<T | null> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [column, value] of Object.entries(filters)) {
    url.searchParams.set(column, `eq.${value}`);
  }
  url.searchParams.set('select', columns);
  url.searchParams.set('limit', '1');
  const response = await fetch(url, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) {
    throw new Error(`${table} query failed with ${response.status}`);
  }
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new TypeError(`${table} returned no row array`);
  return (rows[0] ?? null) as T | null;
}

function isScorableDeclineReason(value: unknown): value is Exclude<DeclineReason, 'corrupt_file'> {
  return value === 'no_face' || value === 'apparent_minor' ||
    value === 'not_a_photo' || value === 'model_refusal';
}

/** Validate the portion of the stored rubric response used in scoring. */
function readVerdict(value: unknown): Verdict {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    throw new TypeError('Stored assessment is not a rubric response');
  }
  if (value.status === 'declined') {
    if (!('reason' in value) || !('detail' in value) ||
      !isScorableDeclineReason(value.reason) || typeof value.detail !== 'string') {
      throw new TypeError('Stored decline is invalid');
    }
    return { status: 'declined', reason: value.reason, detail: value.detail };
  }
  if (value.status !== 'assessed' || !('assessment' in value) ||
    typeof value.assessment !== 'object' || value.assessment === null) {
    throw new TypeError('Stored assessment is invalid');
  }
  const judged = value.assessment as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const axis of ['background', 'attire', 'expression', 'solo']) {
    const entry = judged[axis];
    if (typeof entry !== 'object' || entry === null || !('score' in entry) ||
      typeof entry.score !== 'number' || !Number.isInteger(entry.score) ||
      entry.score < 1 || entry.score > 5) {
      throw new TypeError(`Stored assessment has an invalid ${axis} score`);
    }
    scores[axis] = entry.score;
  }
  return {
    status: 'assessed',
    assessment: {
      background: scores['background'] as number,
      attire: scores['attire'] as number,
      expression: scores['expression'] as number,
      solo: scores['solo'] as number,
    },
  };
}

/** Scores are append-only, matching packages/db's insertScore helper. */
async function persistScore(photoId: string, result: ScoreResultShape): Promise<void> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/scores`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify({
      photo_id: photoId,
      context: result.context,
      score: result.score,
      axis_scores: result.axes,
      weights_version: result.weightsVersion,
    }),
  });
  if (!response.ok) throw new Error(`scores insert failed with ${response.status}`);
}

Deno.serve(async (request: Request): Promise<Response> => {
  // The preflight has to answer before the POST is ever sent, and it
  // must not fall through to the 405 below.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Use POST' }, 405);
  }

  let body: { photoId?: unknown; context?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const photoId = typeof body.photoId === 'string' ? body.photoId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(photoId)) {
    return json({ error: 'photoId must be a UUID' }, 400);
  }

  const rawContext = typeof body.context === 'string' ? body.context : 'corporate';
  if (!isContext(rawContext)) {
    return json({ error: `Unknown context ${rawContext}` }, 400);
  }

  let features: FeatureRow | null;
  try {
    features = await selectOne<FeatureRow>('features', { photo_id: photoId }, 'computed,extractor_version');
  } catch (error) {
    return internalFailure('feature query', error);
  }
  if (features === null) {
    // Extraction is a separate pipeline stage, never done in Edge.
    return json({ error: 'Features not extracted yet', photoId }, 409);
  }

  let computed: ValidatedFeatures;
  try {
    const parsed = ComputedFeatures.parse(features.computed);
    assertFeaturesUsable(parsed);
    computed = parsed;
  } catch {
    return json({ error: 'Cached features are unusable', photoId }, 422);
  }
  if (belowDimensionFloor(computed.width, computed.height)) {
    return json({
      error: `Images must be at least ${MIN_IMAGE_SHORT_EDGE_PX}px on the shorter edge.`,
      code: 'below_dimension_floor',
      photoId,
    }, 422);
  }
  if (computed.extractorVersion !== features.extractor_version ||
    computed.extractorVersion !== WEIGHTS_V1.compatibleExtractorVersion) {
    return json({ error: 'Features need re-extraction for the current weights', photoId }, 409);
  }

  if (computed.faceCount === 0) {
    // No VLM assessment exists by design. Keep the computed axes and
    // decline without inventing any of the four judged measurements.
    const result = score({
      features: computed,
      context: rawContext,
      confidence: computeConfidence(computed, { soloScore: null }),
      declined: 'no_face',
    });
    try {
      await persistScore(photoId, result);
    } catch (error) {
      return internalFailure('score persistence', error);
    }
    return declined('no_face', 'No usable face was found in this photo.', result);
  }
  let assessment: AssessmentRow | null;
  try {
    assessment = await selectOne<AssessmentRow>(
      'assessments',
      { photo_id: photoId, source: 'vlm', model: ACTIVE_VLM_MODEL },
      'axes',
    );
  } catch (error) {
    return internalFailure('assessment query', error);
  }
  if (assessment === null) {
    // A face exists, so a missing VLM assessment is an incomplete stage.
    return json({ error: 'Assessment not recorded yet', photoId }, 409);
  }

  let verdict: Verdict;
  try {
    verdict = readVerdict(assessment.axes);
  } catch (error) {
    return internalFailure('stored assessment invalid', error, 422);
  }

  if (verdict.status === 'declined') {
    const result = score({
      features: computed,
      context: rawContext,
      confidence: computeConfidence(computed, { soloScore: null }),
      declined: verdict.reason,
    });
    try {
      await persistScore(photoId, result);
    } catch (error) {
      return internalFailure('score persistence', error);
    }
    return declined(
      verdict.reason,
      verdict.detail === '' ? 'This image cannot be assessed as a profile photo.' : verdict.detail,
      result,
    );
  }

  // A scored VLM reply supplies all four judged axes. Its solo score is
  // present, so it participates in the detector/model disagreement check.
  const result = score({
    features: computed,
    judged: verdict.assessment,
    context: rawContext,
    confidence: computeConfidence(computed, { soloScore: verdict.assessment.solo }),
  });
  try {
    await persistScore(photoId, result);
  } catch (error) {
    return internalFailure('score persistence', error);
  }
  return json({ status: 'scored', result });
});
