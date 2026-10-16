import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiErrorResponseSchema, healthResponseSchema } from '../../src/contracts/api.js';
import { createApp } from '../../src/http/app.js';
import { validateBody } from '../../src/http/middleware.js';
import { capturingLogger, silentLogger, testConfig } from '../helpers.js';

const FAKE_SECRET = 'mongodb://admin:TopSecretValue@db.internal:27017';

function testRouter(): Router {
  const router = Router();
  router.post(
    '/test/echo',
    validateBody(z.object({ name: z.string().min(2), quantity: z.number().int().min(0) }).strict()),
    (_req, res) => res.json({ received: res.locals.body }),
  );
  router.get('/test/boom', () => {
    throw new Error(`database exploded at ${FAKE_SECRET}`);
  });
  return router;
}

function app(options: { pingResult?: boolean; env?: Record<string, string> } = {}) {
  const config = testConfig(options.env);
  const database =
    options.pingResult === undefined
      ? undefined
      : { ping: async () => options.pingResult as boolean };
  return createApp({ config, logger: silentLogger, database, extraRouters: [testRouter()] });
}

describe('health endpoints', () => {
  it('GET /api/health returns ok without configuration details', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(res.body).status).toBe('ok');
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb|127\.0\.0\.1|pms_test/i);
  });

  it('GET /api/health/ready reports database up and down', async () => {
    const up = await request(app({ pingResult: true })).get('/api/health/ready');
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ status: 'ready', checks: { database: 'up' } });

    const down = await request(app({ pingResult: false })).get('/api/health/ready');
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ status: 'not_ready', checks: { database: 'down' } });

    const none = await request(app()).get('/api/health/ready');
    expect(none.status).toBe(503);
  });

  it('treats a throwing database probe as down', async () => {
    const config = testConfig();
    const throwing = createApp({
      config,
      logger: silentLogger,
      database: {
        ping: async () => {
          throw new Error('boom');
        },
      },
    });
    const res = await request(throwing).get('/api/health/ready');
    expect(res.status).toBe(503);
  });
});

describe('request validation and errors', () => {
  it('returns 400 with field details for invalid input', async () => {
    const res = await request(app())
      .post('/api/test/echo')
      .send({ name: 'x', quantity: -1, extra: true });
    expect(res.status).toBe(400);
    const body = apiErrorResponseSchema.parse(res.body);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details?.map((d) => d.path)).toEqual(
      expect.arrayContaining(['name', 'quantity']),
    );
  });

  it('accepts valid input', async () => {
    const res = await request(app())
      .post('/api/test/echo')
      .send({ name: 'Synthetic', quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { name: 'Synthetic', quantity: 3 } });
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app())
      .post('/api/test/echo')
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 413 when the body exceeds the configured limit', async () => {
    const res = await request(app({ env: { REQUEST_BODY_LIMIT: '1kb' } }))
      .post('/api/test/echo')
      .send({ name: 'x'.repeat(5000), quantity: 1 });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(app()).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('hides internal error details from clients and logs', async () => {
    const { logger, lines } = capturingLogger();
    const leaky = createApp({ config: testConfig(), logger, extraRouters: [testRouter()] });
    const res = await request(leaky).get('/api/test/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(JSON.stringify(res.body)).not.toContain('TopSecretValue');
    expect(lines.join('\n')).not.toContain('TopSecretValue');
    expect(lines.join('\n')).toContain('unhandled error');
  });

  it('assigns and echoes a request id', async () => {
    const generated = await request(app()).get('/api/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await request(app()).get('/api/health').set('X-Request-Id', 'client-req-12345');
    expect(echoed.headers['x-request-id']).toBe('client-req-12345');
    const rejected = await request(app()).get('/api/health').set('X-Request-Id', '<script>');
    expect(rejected.headers['x-request-id']).not.toBe('<script>');
  });
});

describe('security headers, CORS and rate limiting', () => {
  it('sets security headers and hides the framework', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('allows configured origins with credentials', async () => {
    const res = await request(app()).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects other origins, including preflight requests', async () => {
    const res = await request(app()).get('/api/health').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await request(app())
      .options('/api/test/echo')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(403);
  });

  it('answers allowed preflight requests', async () => {
    const preflight = await request(app())
      .options('/api/test/echo')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('never sends a wildcard origin', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('limits request rate', async () => {
    const limited = app({ env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' } });
    await request(limited).get('/api/health').expect(200);
    await request(limited).get('/api/health').expect(200);
    const res = await request(limited).get('/api/health');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});
