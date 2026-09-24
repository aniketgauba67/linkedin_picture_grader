import { describe, expect, it } from 'vitest';

import {
  PexelsClient,
  PexelsError,
  pickSource,
  PREFERRED_SIZES,
  QUOTA_RESERVE,
  type PexelsPhoto,
} from './pexels.js';

function photo(overrides: Partial<PexelsPhoto> = {}): PexelsPhoto {
  return {
    id: 12345,
    width: 4000,
    height: 6000,
    url: 'https://www.pexels.com/photo/example-12345/',
    photographer: 'Ada Lovelace',
    photographer_url: 'https://www.pexels.com/@ada',
    src: {
      original: 'https://images.pexels.com/photos/12345/original.jpeg',
      large2x: 'https://images.pexels.com/photos/12345/large2x.jpeg',
      large: 'https://images.pexels.com/photos/12345/large.jpeg',
    },
    ...overrides,
  };
}

/** No test here reaches the network; every one hands the client a fetch. */
function respond(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('pickSource', () => {
  it('prefers large2x - big enough for a corpus, not a 20MB original', () => {
    expect(pickSource(photo())).toBe('https://images.pexels.com/photos/12345/large2x.jpeg');
    expect(PREFERRED_SIZES[0]).toBe('large2x');
  });

  it('falls back down the list when a size is missing', () => {
    expect(pickSource(photo({ src: { large: 'https://x/large.jpeg' } }))).toBe('https://x/large.jpeg');
    expect(pickSource(photo({ src: { original: 'https://x/o.jpeg' } }))).toBe('https://x/o.jpeg');
  });

  it('returns null rather than guessing when no known size is offered', () => {
    expect(pickSource(photo({ src: { tiny: 'https://x/t.jpeg' } }))).toBeNull();
  });
});

describe('PexelsClient', () => {
  it('refuses an empty key instead of sending an unauthenticated request', () => {
    expect(() => new PexelsClient('')).toThrow(PexelsError);
  });

  it('sends the key as the Authorization header and asks for portraits', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const client = new PexelsClient('secret-key', async (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.['Authorization'] ?? '';
      return respond({ photos: [photo()] });
    });

    await client.search('professional headshot', 80, 1);
    expect(seenAuth).toBe('secret-key');
    expect(seenUrl).toContain('query=professional%20headshot');
    expect(seenUrl).toContain('per_page=80');
    expect(seenUrl).toContain('orientation=portrait');
  });

  it('clamps per_page to the 80 the API allows', async () => {
    let seenUrl = '';
    const client = new PexelsClient('k', async (url) => {
      seenUrl = url;
      return respond({ photos: [] });
    });
    await client.search('x', 500, 1);
    expect(seenUrl).toContain('per_page=80');
  });

  it('reads the quota off the response rather than counting locally', async () => {
    const client = new PexelsClient('k', async () =>
      respond(
        { photos: [] },
        {
          headers: {
            'x-ratelimit-limit': '200',
            'x-ratelimit-remaining': '173',
            'x-ratelimit-reset': '1774000000',
          },
        },
      ),
    );

    await client.search('x', 10, 1);
    expect(client.quota).toEqual({ limit: 200, remaining: 173, reset: 1774000000 });
    expect(client.exhausted).toBe(false);
  });

  it('calls itself exhausted above zero, leaving room for the next run', async () => {
    const client = new PexelsClient('k', async () =>
      respond({ photos: [] }, { headers: { 'x-ratelimit-remaining': String(QUOTA_RESERVE) } }),
    );
    await client.search('x', 10, 1);
    expect(client.exhausted).toBe(true);
  });

  it('is not exhausted before any response has said anything', () => {
    const client = new PexelsClient('k', async () => respond({ photos: [] }));
    expect(client.exhausted).toBe(false);
    expect(client.resetInSeconds).toBeNull();
  });

  it('turns a 429 into an error that says when the quota returns', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const client = new PexelsClient('k', async () =>
      respond('rate limited', { status: 429, headers: { 'x-ratelimit-reset': String(reset) } }),
    );

    await expect(client.search('x', 10, 1)).rejects.toMatchObject({ status: 429 });
    expect(client.resetInSeconds).toBeGreaterThan(500);
  });

  it('reports any other failing status', async () => {
    const client = new PexelsClient('k', async () => respond('nope', { status: 500 }));
    await expect(client.search('x', 10, 1)).rejects.toThrow(/failed with 500/);
  });

  it('rejects a body that is not shaped like a search result', async () => {
    const noPhotos = new PexelsClient('k', async () => respond({ nope: true }));
    await expect(noPhotos.search('x', 10, 1)).rejects.toThrow(/no photos array/);

    const notArray = new PexelsClient('k', async () => respond({ photos: 'lots' }));
    await expect(notArray.search('x', 10, 1)).rejects.toThrow(/non-array/);
  });

  it('drops entries that are not photos rather than passing them on', async () => {
    const client = new PexelsClient('k', async () =>
      respond({ photos: [photo(), { id: 'not-a-number' }, null] }),
    );
    const page = await client.search('x', 10, 1);
    expect(page.photos).toHaveLength(1);
  });

  it('reports the next page only when the API offers one', async () => {
    const more = new PexelsClient('k', async () =>
      respond({ photos: [photo()], next_page: 'https://api.pexels.com/v1/search?page=2' }),
    );
    expect((await more.search('x', 10, 1)).nextPage).toContain('page=2');

    const last = new PexelsClient('k', async () => respond({ photos: [photo()] }));
    expect((await last.search('x', 10, 1)).nextPage).toBeNull();
  });

  it('downloads without the key - the CDN is not the rate-limited host', async () => {
    let sawAuthHeader = true;
    const client = new PexelsClient('k', async (_url, init) => {
      sawAuthHeader = init?.headers !== undefined;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });

    const bytes = await client.download('https://images.pexels.com/photos/1/large2x.jpeg');
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(sawAuthHeader).toBe(false);
  });

  it('reports a failed download instead of writing an error page to disk', async () => {
    const client = new PexelsClient('k', async () => new Response('gone', { status: 404 }));
    await expect(client.download('https://images.pexels.com/x.jpeg')).rejects.toThrow(/404/);
  });
});
