/**
 * The browser side of the whole flow, as one pure function.
 *
 *   hash -> /api/upload-url -> PUT to Storage -> /api/extract -> score
 *
 * `fetch` and the hasher are injected, so every branch is testable
 * without a network. The UI separately tests selection, progress, retry,
 * and reset behavior.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not resize, recompress or
 * strip anything before upload: the server re-hashes the stored bytes
 * and compares them to the hash registered here, so mutating them turns
 * a good upload into a hash mismatch. It does not re-implement any
 * validation the server performs - client checks here exist to save a
 * round trip and are never the authority. And it does not score: the
 * Edge function owns that arithmetic and the client only reads its
 * typed answer.
 */

import {
  AnalysisOutcome,
  ApiError,
  ExtractResponse,
  UploadUrlResponse,
  ACCEPTED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  type MimeType,
} from '@pps/schema';

export type Stage = 'idle' | 'hashing' | 'uploading' | 'analysing' | 'scoring' | 'done' | 'failed';

/** Where a failure happened, so a retry can resume rather than restart. */
export type FailureStage = 'validate' | 'authorize' | 'upload' | 'extract' | 'score';

export class AnalysisError extends Error {
  readonly stage: FailureStage;
  readonly code: string | null;
  /** True when the bytes are already in Storage, so a retry may skip the
   *  upload entirely - the feature cache and the extraction claim make
   *  re-requesting extraction cheap and safe. */
  readonly canResume: boolean;
  readonly photoId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    stage: FailureStage,
    message: string,
    options: { canResume?: boolean; photoId?: string | null; retryAfterSeconds?: number | null; code?: string | null } = {},
  ) {
    super(message);
    this.name = 'AnalysisError';
    this.stage = stage;
    this.code = options.code ?? null;
    this.canResume = options.canResume ?? false;
    this.photoId = options.photoId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export interface AnalyseDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly sha256: (file: Blob) => Promise<string>;
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly onStage?: (stage: Stage) => void;
}

export interface AnalyseInput {
  readonly file: File;
  readonly context?: 'startup' | 'corporate' | 'creative';
  /** Set when resuming: the bytes are already uploaded. */
  readonly resumePhotoId?: string | null;
}

export interface AnalysisResult {
  readonly photoId: string;
  readonly extract: ExtractResponse;
  readonly outcome: AnalysisOutcome;
}

/** Browser-side SHA-256 over the ORIGINAL bytes, via WebCrypto. */
export async function hashFile(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Saves a round trip on the obvious cases. NOT a security boundary:
 *  the server sniffs magic bytes and re-hashes regardless. */
export function quickReject(file: File): string | null {
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Images must be under ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`;
  }
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Upload a JPEG, PNG or WebP image.';
  }
  return null;
}

/** Reads the route's stable error, never a raw provider body. */
async function failureInfo(response: Response, fallback: string): Promise<{ message: string; code: string | null }> {
  try {
    const parsed = ApiError.safeParse(await response.json());
    if (parsed.success) return { message: parsed.data.error, code: parsed.data.code ?? null };
  } catch {
    // A non-JSON body is a provider page or a proxy error. Neither is
    // something to show a user.
  }
  return { message: fallback, code: null };
}

const PERMANENT_IMAGE_ERRORS = new Set([
  'not_an_image', 'mime_mismatch', 'corrupt_file', 'below_dimension_floor', 'hash_mismatch',
]);

function retryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}

export async function analyse(input: AnalyseInput, deps: AnalyseDeps): Promise<AnalysisResult> {
  const stage = (next: Stage): void => deps.onStage?.(next);

  const rejection = quickReject(input.file);
  if (rejection !== null) throw new AnalysisError('validate', rejection);

  let photoId = input.resumePhotoId ?? null;

  if (photoId === null) {
    stage('hashing');
    const sha256 = await deps.sha256(input.file);

    stage('uploading');
    const authorize = await deps.fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: input.file.name,
        contentType: input.file.type as MimeType,
        sha256,
        byteSize: input.file.size,
      }),
    });

    if (!authorize.ok) {
      const failure = await failureInfo(authorize, 'Could not start the upload.');
      throw new AnalysisError(
        'authorize',
        failure.message,
        { code: failure.code, retryAfterSeconds: retryAfter(authorize) },
      );
    }

    const ticket = UploadUrlResponse.parse(await authorize.json());
    photoId = ticket.photoId;

    // The ORIGINAL bytes, unmodified. The server re-hashes them.
    const put = await deps.fetch(ticket.signedUrl, {
      method: 'PUT',
      headers: { 'content-type': input.file.type },
      body: input.file,
    });

    if (!put.ok) {
      // The photo row exists but has no bytes, so a resume would fail
      // the same way. The whole upload has to be redone.
      throw new AnalysisError('upload', 'The upload did not complete. Check your connection and try again.', {
        canResume: false,
        photoId,
      });
    }
  }

  stage('analysing');
  const extractResponse = await deps.fetch('/api/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ photoId }),
  });

  if (!extractResponse.ok) {
    // Temporary failures can resume from uploaded bytes. A known invalid
    // image needs a different file; retrying the same bytes cannot help.
    const failure = await failureInfo(extractResponse, 'Could not analyse this photo.');
    throw new AnalysisError('extract', failure.message, {
      canResume: failure.code === null || !PERMANENT_IMAGE_ERRORS.has(failure.code),
      code: failure.code,
      photoId,
      retryAfterSeconds: retryAfter(extractResponse),
    });
  }

  const extract = ExtractResponse.parse(await extractResponse.json());

  stage('scoring');
  const scoreResponse = await deps.fetch(`${deps.supabaseUrl}/functions/v1/score`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The ANON key, which is public by design; RLS and the signed URL
      // are what protect data. The service role never reaches a browser.
      apikey: deps.supabaseAnonKey,
      authorization: `Bearer ${deps.supabaseAnonKey}`,
    },
    // `photoId`, matching the Edge function's parameter name. It reads
    // `body.photoId` and 400s on anything else, so a rename here is an
    // integration break that no unit test with a stubbed fetch can see.
    body: JSON.stringify({ photoId, context: input.context ?? 'corporate' }),
  });

  if (!scoreResponse.ok) {
    const failure = await failureInfo(scoreResponse, 'Could not score this photo.');
    throw new AnalysisError('score', failure.message, {
      canResume: true,
      code: failure.code,
      photoId,
      retryAfterSeconds: retryAfter(scoreResponse),
    });
  }

  const outcome = AnalysisOutcome.parse(await scoreResponse.json());
  stage('done');
  return { photoId, extract, outcome };
}
