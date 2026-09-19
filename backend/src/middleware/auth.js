import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { AuthError, ForbiddenError } from '../lib/errors.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );
}

/** Require a valid JWT; attaches `req.user = { id, email, role, name }`. */
export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new AuthError('Missing bearer token'));
  }
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = { id: payload.sub, email: payload.email, role: payload.role, name: payload.name };
    return next();
  } catch {
    return next(new AuthError('Invalid or expired token'));
  }
}

/** Roles a role stands in for: a senior broker is a broker with the extra
    power to approve renewal packs, so anything open to a broker is open to
    them. */
const IMPLIED_ROLES = { senior_broker: ['broker'] };

/** Whether a user's role satisfies one of the required roles. */
export function hasRole(userRole, roles) {
  return roles.includes(userRole) || (IMPLIED_ROLES[userRole] || []).some((r) => roles.includes(r));
}

/** Require the authenticated user to hold one of the given roles. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new AuthError());
    if (!hasRole(req.user.role, roles)) {
      return next(new ForbiddenError(`Requires role: ${roles.join(' or ')}`));
    }
    return next();
  };
}
