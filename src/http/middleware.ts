import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import type { ApiErrorResponse } from '../contracts/api.js';
import { AppError, NotFoundError } from '../errors.js';
import type { Logger } from '../logger.js';
import { parseOrThrow } from '../validation.js';

const INCOMING_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Assigns a request id (reusing a well-formed incoming `X-Request-Id`) and echoes it back. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const id = incoming && INCOMING_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

/** Logs one line per request: method, path (no query string), status and duration. */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info(
        {
          requestId: res.locals.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        },
        'request completed',
      );
    });
    next();
  };
}

/** Validates `req.body` and stores the parsed value in `res.locals.body`. */
export function validateBody<T>(schema: z.ZodType<T>): RequestHandler {
  return (req, res, next) => {
    res.locals.body = parseOrThrow(schema, req.body);
    next();
  };
}

export function sendError(res: Response, status: number, body: ApiErrorResponse['error']): void {
  const payload: ApiErrorResponse = {
    error: { ...body, requestId: res.locals.requestId as string | undefined },
  };
  res.status(status).json(payload);
}

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => next(new NotFoundError('Route not found'));
}

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

/**
 * Final error handler. Known AppErrors return their safe message; everything else returns a
 * generic message. Details of unexpected errors go to the server log only.
 */
export function errorHandler(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof AppError) {
      sendError(res, err.status, {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }
    const parserError = err as BodyParserError;
    if (parserError?.type === 'entity.too.large') {
      sendError(res, 413, { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' });
      return;
    }
    if (parserError?.type === 'entity.parse.failed') {
      sendError(res, 400, { code: 'BAD_REQUEST', message: 'Malformed JSON request body' });
      return;
    }
    if (parserError?.status && parserError.status >= 400 && parserError.status < 500) {
      sendError(res, parserError.status, { code: 'BAD_REQUEST', message: 'Bad request' });
      return;
    }
    logger.error(
      { requestId: res.locals.requestId, errName: (err as Error)?.name ?? 'UnknownError' },
      'unhandled error',
    );
    sendError(res, 500, { code: 'INTERNAL_ERROR', message: 'Internal server error' });
  };
}
