/** Typed application errors. The error middleware maps `.status` to HTTP. */

export class AppError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Resource') {
    super(`${what} not found`, 404, 'not_found');
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, 422, 'validation');
    this.details = details;
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'conflict');
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'unauthorized');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'forbidden');
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many attempts, try again later') {
    super(message, 429, 'rate_limited');
  }
}
