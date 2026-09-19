import { AppError } from '../lib/errors.js';
import { StatusError } from '../domain/statusMachine.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  // Domain status errors carry their own HTTP status.
  if (err instanceof StatusError) {
    return res.status(err.status || 409).json({ error: err.message, code: 'illegal_transition' });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  // Ids are UUIDs: text that is not one never matches a row, so it is a bad
  // request (22P02 = invalid_text_representation), not a server fault.
  if (err && err.code === '22P02') {
    return res.status(400).json({ error: 'Malformed id or value', code: 'invalid_input' });
  }
  // Postgres unique / FK / check violations -> 409.
  if (err && typeof err.code === 'string' && err.code.startsWith('23')) {
    return res.status(409).json({ error: 'Constraint violation', code: 'db_constraint', detail: err.detail });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error', code: 'internal' });
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Route not found', code: 'route_not_found' });
}
