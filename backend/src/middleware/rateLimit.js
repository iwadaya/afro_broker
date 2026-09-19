import { RateLimitError } from '../lib/errors.js';

/**
 * Fixed-window, in-memory rate limiter.
 *
 * Deliberately dependency-free and per-process: it exists to blunt credential
 * stuffing against a single instance, not to be a distributed quota system. If
 * the deployment ever runs several instances behind a load balancer, move this
 * to a shared store (Redis) — until then, per-process is the honest scope.
 *
 * With `onlyFailures` (the default) a successful request costs nothing, so
 * ordinary users never hit the limit no matter how often they sign in, while a
 * password-guessing loop burns its budget almost immediately.
 */
export function rateLimit({
  windowMs = 15 * 60 * 1000,
  max = 10,
  enabled = true,
  onlyFailures = true,
  keyOf = (req) => req.ip || 'unknown',
} = {}) {
  if (!enabled) return (_req, _res, next) => next();

  const buckets = new Map();

  // Drop expired buckets periodically so an attacker cycling source addresses
  // can't grow the map without bound. Unref'd so it never holds the process up.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }, windowMs);
  sweep.unref?.();

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = keyOf(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    if (bucket.count >= max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return next(new RateLimitError());
    }

    if (onlyFailures) {
      res.on('finish', () => {
        if (res.statusCode >= 400) bucket.count += 1;
      });
    } else {
      bucket.count += 1;
    }
    return next();
  };
}
