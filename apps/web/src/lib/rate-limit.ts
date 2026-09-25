/** Shared Postgres rate limits. Unknown backend state always denies work. */

import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { serviceClient } from './supabase';

export type RateLimitResult =
  | { readonly allowed: true; readonly reason: ''; readonly retryAfterSeconds: 0; readonly unavailable: false }
  | { readonly allowed: false; readonly reason: string; readonly retryAfterSeconds: number; readonly unavailable: boolean };

export interface LimitConfig {
  readonly perIpPerHour: number;
  readonly globalPerHour: number;
  readonly windowMs: number;
}

export const DEFAULT_LIMITS: LimitConfig = {
  // Enough for a person trying several photographs, nowhere near enough
  // to be worth scripting.
  perIpPerHour: 20,
  // The budget ceiling. A VLM call is the cost that matters.
  globalPerHour: 500,
  windowMs: 60 * 60 * 1000,
};

const Decision = z.union([
  z.object({ allowed: z.literal(true), bucket: z.null(), retryAfterSeconds: z.literal(0) }).strict(),
  z.object({
    allowed: z.literal(false),
    bucket: z.enum(['ip', 'global']),
    retryAfterSeconds: z.number().int().positive(),
  }).strict(),
]);

const UNAVAILABLE: RateLimitResult = {
  allowed: false,
  unavailable: true,
  reason: 'Rate limiting is temporarily unavailable. Try again shortly.',
  retryAfterSeconds: 0,
};

/** The service-role key is server-only and also keys a domain-separated IP HMAC. */
export async function checkRateLimit(
  ip: string | null,
  config: LimitConfig = DEFAULT_LIMITS,
): Promise<RateLimitResult> {
  if (ip === null || ip.trim() === '') return UNAVAILABLE;

  const secret = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (secret === undefined || secret === '') return UNAVAILABLE;

  const ipHash = createHmac('sha256', secret).update('pps-rate-limit-ip:v1\0').update(ip).digest('hex');
  try {
    const { data, error } = await serviceClient()
      .rpc('consume_rate_limit', {
        p_ip_hash: ipHash,
        p_per_ip_limit: config.perIpPerHour,
        p_global_limit: config.globalPerHour,
        p_window_seconds: Math.floor(config.windowMs / 1000),
      })
      .abortSignal(AbortSignal.timeout(3_000));
    if (error !== null) return UNAVAILABLE;
    const parsed = Decision.safeParse(data);
    if (!parsed.success) return UNAVAILABLE;
    if (parsed.data.allowed) {
      return { allowed: true, unavailable: false, reason: '', retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      unavailable: false,
      reason: parsed.data.bucket === 'ip'
        ? 'Too many uploads from this address. Try again later.'
        : 'This service is at capacity. Try again shortly.',
      retryAfterSeconds: parsed.data.retryAfterSeconds,
    };
  } catch {
    return UNAVAILABLE;
  }
}

/** Vercel sets x-forwarded-for; the leftmost entry is the client. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded.trim() !== '') {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return first;
  }
  const real = headers.get('x-real-ip');
  return real !== null && real.trim() !== '' ? real.trim() : null;
}
