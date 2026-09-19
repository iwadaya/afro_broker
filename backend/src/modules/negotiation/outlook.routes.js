// The Outlook mailbox the submissions go out from and the replies come back
// into: connect it (Microsoft sign-in), see it, read its inbox now, drop it.
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { asyncHandler } from '../../lib/http.js';
import { ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';
import {
  outlookSettings, authorizeUrl, completeConnect, disconnect, loadAccount, publicAccount,
} from '../../integrations/outlook.js';
import { syncInbox } from './replies.js';

const router = Router();

// The sign-in round trip: a state token handed to Microsoft and checked on
// the way back, so a callback can only finish a connection someone started.
const pending = new Map(); // state -> { userId, expires }
const STATE_TTL_MS = 10 * 60 * 1000;

function afterConnect(outcome, detail) {
  const q = new URLSearchParams({ outlook: outcome, ...(detail ? { detail } : {}) });
  return `${config.appUrl || ''}/admin?${q}`;
}

/** What the UI shows: is a mailbox connected, which, when it last read its inbox. */
router.get(
  '/outlook/status',
  authenticate,
  asyncHandler(async (_req, res) => {
    const s = outlookSettings();
    const account = await loadAccount();
    res.json({
      configured: s.configured,
      redirect_uri: s.redirectUri,
      tenant: s.tenant,
      sync_interval_ms: s.syncIntervalMs,
      connected: !!account,
      account: publicAccount(account),
    });
  }),
);

/** Start the sign-in: where to send the browser. */
router.post(
  '/outlook/connect',
  authenticate,
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const s = outlookSettings();
    if (!s.configured) {
      throw new ValidationError('Outlook is not configured on this server — set MS_CLIENT_ID and MS_CLIENT_SECRET from an Azure app registration');
    }
    const state = randomBytes(24).toString('base64url');
    pending.set(state, { userId: req.user.id, expires: Date.now() + STATE_TTL_MS });
    for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
    res.json({ url: authorizeUrl(state), redirect_uri: s.redirectUri });
  }),
);

/** Microsoft sends the browser back here; no bearer token on a redirect. */
router.get(
  '/outlook/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error, error_description: description } = req.query;
    const started = state && pending.get(String(state));
    pending.delete(String(state));
    if (!started || started.expires < Date.now()) return res.redirect(afterConnect('error', 'The sign-in link had expired — start again from the Admin page'));
    if (error || !code) return res.redirect(afterConnect('error', String(description || error || 'no code')));
    try {
      const account = await completeConnect(String(code), started.userId);
      await audit({ entityType: 'mail_account', entityId: account.id, action: 'connect', userId: started.userId, detail: { address: account.address } });
      return res.redirect(afterConnect('connected'));
    } catch (e) {
      return res.redirect(afterConnect('error', e.message));
    }
  }),
);

router.post(
  '/outlook/disconnect',
  authenticate,
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const account = await loadAccount();
    await disconnect();
    if (account) await audit({ entityType: 'mail_account', entityId: account.id, action: 'disconnect', userId: req.user.id });
    res.json({ connected: false });
  }),
);

/** Read the inbox now, rather than waiting for the next poll. */
router.post(
  '/outlook/sync',
  authenticate,
  requireRole('broker', 'admin'),
  asyncHandler(async (_req, res) => {
    res.json(await syncInbox());
  }),
);

export default router;
