import { z } from 'zod';

/**
 * Images go browser -> Supabase Storage directly via a signed URL. They
 * never pass through a Vercel route, which caps request bodies at 4.5MB.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const MimeType = z.enum(ACCEPTED_MIME_TYPES);

export const UploadRequest = z.object({
  filename: z.string().min(1).max(255),
  contentType: MimeType,
  byteSize: z.number().finite().int().positive().max(MAX_UPLOAD_BYTES),
});

export const UploadTicket = z.object({
  imageId: z.string().uuid(),
  storagePath: z.string().min(1),
  signedUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});

export const ImageRecord = z.object({
  id: z.string().uuid(),
  storagePath: z.string().min(1),
  contentType: MimeType,
  byteSize: z.number().finite().int().positive(),
  createdAt: z.string().datetime(),
});

export type MimeType = z.infer<typeof MimeType>;
export type UploadRequest = z.infer<typeof UploadRequest>;
export type UploadTicket = z.infer<typeof UploadTicket>;
export type ImageRecord = z.infer<typeof ImageRecord>;
