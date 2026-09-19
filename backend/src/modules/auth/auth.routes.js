import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, AuthError, ConflictError } from '../../lib/errors.js';
import { signToken, authenticate, requireRole } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';

const router = Router();

// Only failed sign-ins count against the budget, so legitimate traffic is
// unaffected while brute-force attempts are cut off quickly.
const loginLimiter = rateLimit({
  enabled: config.rateLimit.enabled,
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxLoginFailures,
});

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
  role: z.enum(['broker', 'senior_broker', 'underwriter', 'admin']),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active };
}

// Admin-only user provisioning. The first user can be created via the seed script.
router.post(
  '/register',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = validate(registerSchema, req.body);
    const exists = await query('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (exists.rowCount) throw new ConflictError('Email already registered');
    const hash = await bcrypt.hash(body.password, 10);
    const { rows } = await query(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.email, body.name, hash, body.role],
    );
    await audit({ entityType: 'user', entityId: rows[0].id, action: 'create', userId: req.user.id });
    res.status(201).json(publicUser(rows[0]));
  }),
);

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = validate(loginSchema, req.body);
    const { rows } = await query('SELECT * FROM users WHERE email = $1 AND active = TRUE', [body.email]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(body.password, user.password_hash));
    if (!ok) throw new AuthError('Invalid credentials');
    res.json({ token: signToken(user), user: publicUser(user) });
  }),
);

/* Demo sign-in: the users to pick from on the login screen, with the one
   demo password, when DEMO_PASSWORD is set. Public by design — it is the
   demonstration's front door — and empty otherwise. */
router.get(
  '/demo-users',
  asyncHandler(async (_req, res) => {
    if (!config.demoPassword) return res.json({ enabled: false, users: [] });
    const { rows } = await query(
      `SELECT email, name, role FROM users WHERE active = TRUE
       ORDER BY array_position(ARRAY['broker','senior_broker','underwriter','admin'], role), name`,
    );
    res.json({ enabled: true, password: config.demoPassword, users: rows });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) throw new AuthError();
    res.json(publicUser(rows[0]));
  }),
);

router.get(
  '/users',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query('SELECT * FROM users ORDER BY created_at');
    res.json(rows.map(publicUser));
  }),
);

const userPatchSchema = z.object({
  role: z.enum(['broker', 'senior_broker', 'underwriter', 'admin']).optional(),
  active: z.boolean().optional(),
  name: z.string().min(1).optional(),
});

/* Change a user's role, name or active flag. Admin only; an admin cannot
   demote or deactivate themselves, so there is always someone left to fix it. */
router.patch(
  '/users/:id',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = validate(userPatchSchema, req.body);
    const { rows: cur } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!cur[0]) throw new NotFoundError('User');
    if (cur[0].id === req.user.id && ((body.role && body.role !== 'admin') || body.active === false)) {
      throw new ConflictError('An admin cannot demote or deactivate their own account');
    }
    const { rows } = await query(
      `UPDATE users SET role = COALESCE($1, role), active = COALESCE($2, active), name = COALESCE($3, name)
       WHERE id = $4 RETURNING *`,
      [body.role ?? null, body.active ?? null, body.name ?? null, req.params.id],
    );
    await audit({
      entityType: 'user', entityId: req.params.id, action: 'update', userId: req.user.id,
      detail: { from: { role: cur[0].role, active: cur[0].active }, to: { role: rows[0].role, active: rows[0].active } },
    });
    res.json(publicUser(rows[0]));
  }),
);

export default router;
