import type { ApiErrorCode } from './contracts/api.js';

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * Base class for errors whose message is safe to return to API clients.
 * Never put secrets, connection strings or personal data in these messages.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[], message = 'Input validation failed') {
    super(400, 'VALIDATION_FAILED', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(503, 'SERVICE_UNAVAILABLE', message);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(
    message = 'Sign in required',
    code: 'UNAUTHENTICATED' | 'SESSION_EXPIRED' = 'UNAUTHENTICATED',
  ) {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission for this action',
    code: 'FORBIDDEN' | 'CSRF_FAILED' = 'FORBIDDEN',
  ) {
    super(403, code, message);
  }
}
