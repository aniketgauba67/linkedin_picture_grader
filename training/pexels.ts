/**
 * Pexels API client.
 *
 * Two different hosts with two different rules, and conflating them is
 * the mistake worth avoiding:
 *
 *   api.pexels.com    - rate limited, 200 requests/hour on the free tier,
 *                       and it TELLS you where you stand in the response
 *                       headers. Searches only.
 *   images.pexels.com - a CDN. Not part of the quota, but still somebody
 *                       else's bandwidth, so downloads run at a modest
 *                       fixed concurrency rather than all at once.
 *
 * The limiter reads X-Ratelimit-Remaining and X-Ratelimit-Reset off every
 * response rather than counting locally. A local counter is wrong the
 * moment anything else uses the same key - another terminal, a half
 * finished earlier run - and being wrong here means a 429 mid-collection.
 */

export const RATE_LIMIT_HEADERS = {
  limit: 'x-ratelimit-limit',
  remaining: 'x-ratelimit-remaining',
  reset: 'x-ratelimit-reset',
} as const;

/** Stop this far above zero, so a later run has room to resume. */
export const QUOTA_RESERVE = 5;

export class PexelsError extends Error {
  readonly status: number;
  /** Seconds until the quota resets, when the response said. */
  readonly resetInSeconds: number | null;

  constructor(message: string, status: number, resetInSeconds: number | null = null) {
    super(message);
    this.name = 'PexelsError';
    this.status = status;
    this.resetInSeconds = resetInSeconds;
  }
}

export interface PexelsPhoto {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly url: string;
  readonly photographer: string;
  readonly photographer_url: string;
  readonly src: Readonly<Record<string, string>>;
}

export interface SearchPage {
  readonly photos: readonly PexelsPhoto[];
  readonly nextPage: string | null;
}

export interface QuotaState {
  readonly limit: number | null;
  readonly remaining: number | null;
  /** Unix seconds. */
  readonly reset: number | null;
}

export interface FetchLike {
  (url: string, init?: { headers?: Record<string, string> }): Promise<Response>;
}

function readNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The size to download.
 *
 * `large2x` is a 1880px-wide re-encode, which is plenty for a corpus and
 * a fraction of the original. NOT `original`: those run to 20MB+ and
 * resolution is one of the eight axes, so downloading a 6000px file only
 * to have every image score 5 on resolution teaches the scorer nothing
 * that a smaller file would not.
 */
export const PREFERRED_SIZES: readonly string[] = ['large2x', 'large', 'original'];

export function pickSource(photo: PexelsPhoto): string | null {
  for (const size of PREFERRED_SIZES) {
    const url = photo.src[size];
    if (typeof url === 'string' && url !== '') return url;
  }
  return null;
}

export class PexelsClient {
  readonly #key: string;
  readonly #fetch: FetchLike;
  #quota: QuotaState = { limit: null, remaining: null, reset: null };

  constructor(key: string, fetchImpl: FetchLike = fetch) {
    if (key === '') throw new PexelsError('PEXELS_API_KEY is empty', 0);
    this.#key = key;
    this.#fetch = fetchImpl;
  }

  get quota(): QuotaState {
    return this.#quota;
  }

  /** Seconds until reset, or null when no response has said. */
  get resetInSeconds(): number | null {
    const reset = this.#quota.reset;
    return reset === null ? null : Math.max(0, reset - Math.floor(Date.now() / 1000));
  }

  /**
   * True when the quota is spent. The caller stops on this rather than
   * discovering it as a 429, because a run that stops cleanly is
   * resumable and a run that 429s halfway may not be.
   */
  get exhausted(): boolean {
    const remaining = this.#quota.remaining;
    return remaining !== null && remaining <= QUOTA_RESERVE;
  }

  #absorbHeaders(response: Response): void {
    this.#quota = {
      limit: readNumber(response.headers, RATE_LIMIT_HEADERS.limit) ?? this.#quota.limit,
      remaining: readNumber(response.headers, RATE_LIMIT_HEADERS.remaining) ?? this.#quota.remaining,
      reset: readNumber(response.headers, RATE_LIMIT_HEADERS.reset) ?? this.#quota.reset,
    };
  }

  async search(query: string, perPage: number, page: number): Promise<SearchPage> {
    const url =
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}` +
      `&per_page=${Math.min(Math.max(perPage, 1), 80)}&page=${Math.max(page, 1)}&orientation=portrait`;

    const response = await this.#fetch(url, { headers: { Authorization: this.#key } });
    this.#absorbHeaders(response);

    if (response.status === 429) {
      throw new PexelsError(
        `Pexels rate limit reached for this key. Resets in ${this.resetInSeconds ?? '?'}s.`,
        429,
        this.resetInSeconds,
      );
    }
    if (!response.ok) {
      throw new PexelsError(`Pexels search failed with ${response.status}`, response.status);
    }

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('photos' in body)) {
      throw new PexelsError('Pexels search returned no photos array', response.status);
    }
    const photos = (body as { photos: unknown }).photos;
    if (!Array.isArray(photos)) {
      throw new PexelsError('Pexels search returned a non-array photos field', response.status);
    }

    const nextPage = (body as { next_page?: unknown }).next_page;
    return {
      photos: photos.filter(isPhoto),
      nextPage: typeof nextPage === 'string' && nextPage !== '' ? nextPage : null,
    };
  }

  /** CDN download. No Authorization header - the quota does not apply. */
  async download(url: string): Promise<Buffer> {
    const response = await this.#fetch(url);
    if (!response.ok) {
      throw new PexelsError(`Download failed with ${response.status}: ${url}`, response.status);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function isPhoto(value: unknown): value is PexelsPhoto {
  if (typeof value !== 'object' || value === null) return false;
  const photo = value as Record<string, unknown>;
  return (
    typeof photo['id'] === 'number' &&
    typeof photo['width'] === 'number' &&
    typeof photo['height'] === 'number' &&
    typeof photo['url'] === 'string' &&
    typeof photo['photographer'] === 'string' &&
    typeof photo['src'] === 'object' &&
    photo['src'] !== null
  );
}
