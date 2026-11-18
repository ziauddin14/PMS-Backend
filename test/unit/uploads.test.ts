import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { cloudinarySignature, signUpload } from '../../src/uploads/cloudinary.js';

// Synthetic, non-working credentials only.
const uploads = {
  cloudName: 'synthetic-cloud',
  apiKey: '123456789012345',
  apiSecret: 'synthetic-secret-value',
  folder: 'mab-pms',
};

describe('Cloudinary signed uploads', () => {
  it('signs the sorted parameters followed by the secret with SHA-1', () => {
    const expected = createHash('sha1')
      .update('folder=a&timestamp=1' + 'synthetic-secret-value')
      .digest('hex');
    expect(cloudinarySignature({ timestamp: '1', folder: 'a' }, 'synthetic-secret-value')).toBe(
      expected,
    );
  });

  it('returns a signature for one purpose folder and never the secret', () => {
    const signed = signUpload(uploads, 'dispatch', new Date('2026-01-01T00:00:00Z'));
    expect(signed).toMatchObject({
      uploadUrl: 'https://api.cloudinary.com/v1_1/synthetic-cloud/auto/upload',
      apiKey: '123456789012345',
      folder: 'mab-pms/dispatch',
      timestamp: '1767225600',
      allowedFormats: 'jpg,jpeg,png,webp,heic,pdf',
    });
    expect(signed.signature).toBe(
      cloudinarySignature(
        {
          allowed_formats: signed.allowedFormats,
          folder: signed.folder,
          timestamp: signed.timestamp,
        },
        uploads.apiSecret,
      ),
    );
    expect(JSON.stringify(signed)).not.toContain(uploads.apiSecret);
  });

  it('reports a clear 503 when uploads are not configured', () => {
    expect(() => signUpload(null, 'payment')).toThrow(/not set up/);
  });

  it('requires all three Cloudinary settings together and never echoes them', () => {
    const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017', MONGODB_DB_NAME: 'pms_test' };
    expect(loadConfig(base).uploads).toBeNull();
    try {
      loadConfig({ ...base, CLOUDINARY_CLOUD_NAME: 'synthetic-cloud' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).toMatch(/must be set together/);
    }
    const config = loadConfig({
      ...base,
      CLOUDINARY_CLOUD_NAME: uploads.cloudName,
      CLOUDINARY_API_KEY: uploads.apiKey,
      CLOUDINARY_API_SECRET: uploads.apiSecret,
    });
    expect(config.uploads).toEqual(uploads);
  });
});
