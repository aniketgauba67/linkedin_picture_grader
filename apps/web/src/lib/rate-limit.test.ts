import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ serviceClient: vi.fn(), rpc: vi.fn() }));
vi.mock('./supabase', () => ({ serviceClient: mocks.serviceClient }));

import { checkRateLimit, DEFAULT_LIMITS } from './rate-limit';

const ALLOWED = { allowed: true, bucket: null, retryAfterSeconds: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  mocks.rpc.mockReturnValue({ abortSignal: async () => ({ data: ALLOWED, error: null }) });
  mocks.serviceClient.mockReturnValue({ rpc: mocks.rpc });
});

afterEach(() => vi.unstubAllEnvs());

describe('shared rate-limit client', () => {
  it('uses the existing 20/IP and 500/global one-hour configuration', async () => {
    expect(DEFAULT_LIMITS).toEqual({ perIpPerHour: 20, globalPerHour: 500, windowMs: 3_600_000 });
    expect((await checkRateLimit('192.0.2.4')).allowed).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith('consume_rate_limit', expect.objectContaining({
      p_per_ip_limit: 20, p_global_limit: 500, p_window_seconds: 3600,
    }));
  });

  it('sends only a stable keyed digest of the IP to Postgres', async () => {
    await checkRateLimit('192.0.2.4');
    await checkRateLimit('192.0.2.4');
    await checkRateLimit('192.0.2.5');
    const hashes: unknown[] = mocks.rpc.mock.calls.map((call) => {
      const args: unknown = call[1];
      return typeof args === 'object' && args !== null && 'p_ip_hash' in args
        ? args.p_ip_hash
        : null;
    });
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(hashes).not.toContain('192.0.2.4');
  });

  it('fails closed when the client address or server secret is unavailable', async () => {
    expect(await checkRateLimit(null)).toMatchObject({ allowed: false, unavailable: true });
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect(await checkRateLimit('192.0.2.4')).toMatchObject({ allowed: false, unavailable: true });
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it('fails closed on RPC errors, aborted calls and malformed decisions', async () => {
    mocks.rpc.mockReturnValueOnce({ abortSignal: async () => ({ data: null, error: { message: 'down' } }) });
    expect(await checkRateLimit('192.0.2.4')).toMatchObject({ allowed: false, unavailable: true });
    mocks.rpc.mockReturnValueOnce({ abortSignal: async () => { throw new Error('aborted'); } });
    expect(await checkRateLimit('192.0.2.4')).toMatchObject({ allowed: false, unavailable: true });
    mocks.rpc.mockReturnValueOnce({ abortSignal: async () => ({ data: { allowed: true }, error: null }) });
    expect(await checkRateLimit('192.0.2.4')).toMatchObject({ allowed: false, unavailable: true });
  });
});
