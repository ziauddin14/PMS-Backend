import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import type { UploadPurpose, UploadSignature } from '../contracts/operations.js';
import { ServiceUnavailableError } from '../errors.js';

/** File types accepted for supporting documents (photos and scanned PDFs). */
export const UPLOAD_ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf'] as const;
/** Largest file accepted (Cloudinary's free plan allows 10 MB per image). */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Cloudinary request signature: the upload parameters sorted by name, joined as `k=v&k=v`,
 * followed by the API secret, hashed with SHA-1 (Cloudinary "authenticated requests").
 */
export function cloudinarySignature(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1')
    .update(toSign + apiSecret)
    .digest('hex');
}

/**
 * Signs one direct browser upload. The file goes from the browser straight to Cloudinary; the
 * API only signs the request, so the secret never leaves the server and files never pass through
 * Render. The signature fixes the folder and allowed file types and expires after about an hour
 * (Cloudinary rejects old timestamps).
 */
export function signUpload(
  config: AppConfig['uploads'],
  purpose: UploadPurpose,
  now: Date = new Date(),
): UploadSignature {
  if (!config) {
    throw new ServiceUnavailableError(
      'Image upload is not set up yet. Ask the administrator to add the Cloudinary settings.',
    );
  }
  const params = {
    allowed_formats: UPLOAD_ALLOWED_FORMATS.join(','),
    folder: `${config.folder}/${purpose}`,
    timestamp: String(Math.floor(now.getTime() / 1000)),
  };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudName}/auto/upload`,
    apiKey: config.apiKey,
    timestamp: params.timestamp,
    folder: params.folder,
    allowedFormats: params.allowed_formats,
    signature: cloudinarySignature(params, config.apiSecret),
    maxBytes: UPLOAD_MAX_BYTES,
  };
}
