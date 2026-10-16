import type { z } from 'zod';
import { ValidationError, type ErrorDetail } from './errors.js';

/** Converts zod issues to client-safe details (path + message, never the rejected value). */
export function toErrorDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/** Parses `input` with `schema`, throwing a ValidationError when it does not match. */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError(toErrorDetails(result.error));
  return result.data;
}
