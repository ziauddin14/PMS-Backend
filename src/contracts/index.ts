/**
 * Public API contract of the backend (response shapes, error codes) and record-code helpers.
 * The frontend keeps a minimal mirror of the response schemas it consumes in
 * `frontend/src/contracts/`; change both together when the contract changes.
 */
export * from './api.js';
export * from './codes.js';
