import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { extractMongoHosts, isLocalMongoUri, redactMongoUri } from '../../src/config/mongoUri.js';

const SECRET = 'Sup3rS3cretPassw0rd';
const base = {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DB_NAME: 'pms_dev',
};

function configError(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('accepts a minimal local configuration and applies safe defaults', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(4000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.mongodb.requireTransactions).toBe(true);
    expect(config.mongodb.allowRemote).toBe(false);
    expect(config.http.bodyLimit).toBe('100kb');
    expect(config.http.corsAllowedOrigins).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('names every missing required variable', () => {
    const error = configError({ NODE_ENV: 'development' });
    expect(error.message).toContain('MONGODB_URI');
    expect(error.message).toContain('MONGODB_DB_NAME');
  });

  it('never includes supplied values in the error message', () => {
    const error = configError({
      ...base,
      MONGODB_URI: `mongodb+srv://pms-user:${SECRET}@cluster0.example.mongodb.net/pms`,
      PORT: `not-a-port-${SECRET}`,
      CORS_ALLOWED_ORIGINS: `https://ok.example.org,javascript:${SECRET}`,
    });
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('pms-user');
    expect(error.message).not.toContain('cluster0');
    expect(error.message).toContain('PORT');
  });

  it('refuses a remote database unless explicitly allowed', () => {
    const remote = { ...base, MONGODB_URI: 'mongodb+srv://u:p@cluster0.example.mongodb.net' };
    expect(configError(remote).message).toContain('MONGODB_ALLOW_REMOTE');
    expect(loadConfig({ ...remote, MONGODB_ALLOW_REMOTE: 'true' }).mongodb.allowRemote).toBe(true);
  });

  it('rejects wildcard and malformed CORS origins', () => {
    expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: '*' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, CORS_ALLOWED_ORIGINS: 'https://a.example.org/path' }),
    ).toThrow(ConfigError);
    const config = loadConfig({
      ...base,
      CORS_ALLOWED_ORIGINS: 'https://pms.example.org, http://localhost:5173',
    });
    expect(config.http.corsAllowedOrigins).toEqual([
      'https://pms.example.org',
      'http://localhost:5173',
    ]);
  });

  it('enforces production rules: explicit CORS origins and transactions', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    const error = configError({ ...prod, MONGODB_REQUIRE_TRANSACTIONS: 'false' });
    expect(error.message).toContain('CORS_ALLOWED_ORIGINS');
    expect(error.message).toContain('MONGODB_REQUIRE_TRANSACTIONS');
    const ok = loadConfig({ ...prod, CORS_ALLOWED_ORIGINS: 'https://pms.example.org' });
    expect(ok.http.corsAllowedOrigins).toEqual(['https://pms.example.org']);
  });

  it('validates numeric ranges, booleans and body limits', () => {
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MONGODB_ALLOW_REMOTE: 'yes' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, REQUEST_BODY_LIMIT: '10gb' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MONGODB_DB_NAME: 'bad name!' })).toThrow(ConfigError);
  });
});

describe('MongoDB URI helpers', () => {
  it('extracts hosts and detects local URIs', () => {
    expect(
      extractMongoHosts('mongodb://a:b@127.0.0.1:27017,localhost:27018/db?replicaSet=rs'),
    ).toEqual(['127.0.0.1', 'localhost']);
    expect(isLocalMongoUri('mongodb://127.0.0.1:27017')).toBe(true);
    expect(isLocalMongoUri('mongodb://db.example.org:27017')).toBe(false);
    expect(isLocalMongoUri('mongodb+srv://localhost')).toBe(false);
  });

  it('redacts credentials', () => {
    expect(redactMongoUri(`mongodb+srv://user:${SECRET}@cluster0.example.net/db`)).toBe(
      'mongodb+srv://***@cluster0.example.net/db',
    );
    expect(redactMongoUri('mongodb://127.0.0.1:27017')).toBe('mongodb://127.0.0.1:27017');
  });
});
