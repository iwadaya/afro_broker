// Typed HTTP errors for the broking module. errorHandler.js maps `status` + `code`
// onto the response and copies the extra fields it knows about; everything else
// rides in `details` and is merged into the body by the module's own handler.
export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const notFound = (what = 'Contract') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
