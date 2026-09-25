/**
 * POST /api/upload-url
 *
 * Registers an intended upload and hands back a signed Storage URL. The
 * bytes never come through here - Vercel caps request bodies at 4.5MB
 * and a photograph can be 10.
 *
 * Always returns an upload URL. The client SHA is recorded as a claim,
 * not proof of the bytes: /api/extract downloads the upload, verifies
 * its server-computed hash, and then reports authoritative `featuresCached`.
 */

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { MimeType, MAX_UPLOAD_BYTES } from '@pps/schema';
import { insertPhoto } from '@pps/db';

import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { PHOTO_BUCKET, UPLOAD_URL_TTL_SECONDS, serviceClient } from '@/lib/supabase';

export const runtime = 'nodejs';

const Body = z.object({
  filename: z.string().min(1).max(255),
  contentType: MimeType,
  /** Lowercase hex. Verified against the real bytes in /api/extract. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().finite().int().positive().max(MAX_UPLOAD_BYTES).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const limit = await checkRateLimit(clientIp(request.headers));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: limit.reason },
      limit.unavailable
        ? { status: 503 }
        : { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      { status: 400 },
    );
  }

  const client = serviceClient();

  // This is a photo registration, not a cache decision. The SHA is
  // client-supplied until /api/extract verifies the stored bytes.
  const extension = parsed.data.contentType === 'image/png' ? 'png' : parsed.data.contentType === 'image/webp' ? 'webp' : 'jpg';
  const storagePath = `${randomUUID()}.${extension}`;

  let photoId: string;
  try {
    const { photo } = await insertPhoto(client, {
      storagePath,
      sha256: parsed.data.sha256,
      uploadedBy: null,
    });
    photoId = photo.id;
  } catch (error) {
    // The raw message is a PostgREST/driver internal and an
    // unauthenticated caller has no business reading it - same rule the
    // Edge scorer follows. It belongs in the platform log instead, where
    // it is also the only signal an operator has that uploads are
    // failing at registration.
    console.error('[api/upload-url] insert photo', error);
    return NextResponse.json({ error: 'Could not register the upload.' }, { status: 500 });
  }

  const signed = await client.storage
    .from(PHOTO_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });

  if (signed.error !== null || signed.data === null) {
    console.error('[api/upload-url] signed url', signed.error ?? 'Storage returned no signed URL');
    return NextResponse.json({ error: 'Could not create an upload URL.' }, { status: 502 });
  }

  return NextResponse.json({
    photoId,
    storagePath,
    signedUrl: signed.data.signedUrl,
    token: signed.data.token,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });
}
