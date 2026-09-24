import { describe, expect, it } from 'vitest';
import { readBrowserEnv, readServiceEnv } from './env.js';

const complete = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

describe('readBrowserEnv', () => {
  it('reads only the two public variables', () => {
    expect(readBrowserEnv(complete)).toEqual({
      url: 'https://example.supabase.co',
      anonKey: 'anon-key',
    });
  });

  it('names the variable it is missing', () => {
    expect(() => readBrowserEnv({ ...complete, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined })).toThrow(
      /NEXT_PUBLIC_SUPABASE_ANON_KEY/,
    );
  });

  it('treats an empty string as missing', () => {
    expect(() => readBrowserEnv({ ...complete, NEXT_PUBLIC_SUPABASE_URL: '  ' })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
  });
});

describe('readServiceEnv', () => {
  it('additionally requires the service role key', () => {
    expect(readServiceEnv(complete).serviceRoleKey).toBe('service-key');
    expect(() => readServiceEnv({ ...complete, SUPABASE_SERVICE_ROLE_KEY: undefined })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});
