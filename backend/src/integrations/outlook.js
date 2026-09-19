/*
 * Outlook, through Microsoft Graph.
 *
 * One mailbox — the broker's Outlook address — is connected once through
 * Microsoft's sign-in (the OAuth authorisation-code flow against the
 * identity platform's `common` endpoint, so a personal Outlook.com / Hotmail
 * address and a work Microsoft 365 account both work). The tokens are held on
 * mail_account and refreshed as they expire. From then on submissions are
 * sent *as* that mailbox (they land in its Sent Items) and its inbox is read
 * for the underwriters' replies.
 *
 * Configuration (an app registration on the Azure portal, "Accounts in any
 * organizational directory and personal Microsoft accounts", with the
 * redirect URI below, delegated permissions offline_access, User.Read,
 * Mail.Send, Mail.ReadWrite):
 *   MS_CLIENT_ID, MS_CLIENT_SECRET   the app registration
 *   MS_TENANT                        `common` (default), `consumers`, or a tenant id
 *   MS_REDIRECT_URI                  where Microsoft sends the browser back —
 *                                    <API origin>/api/outlook/callback
 *
 * Nothing here decides what a reply means; that is the negotiation's job.
 */

import { query } from '../db/pool.js';

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
export const SCOPES = 'offline_access User.Read Mail.Send Mail.ReadWrite';

// The HTTP client, swappable for tests (no network, no Microsoft).
let httpFetch = (...args) => fetch(...args);
export function setFetchForTests(fn) { httpFetch = fn || ((...args) => fetch(...args)); }

export function outlookSettings() {
  const clientId = process.env.MS_CLIENT_ID || '';
  const clientSecret = process.env.MS_CLIENT_SECRET || '';
  return {
    clientId,
    clientSecret,
    tenant: process.env.MS_TENANT || 'common',
    redirectUri: process.env.MS_REDIRECT_URI || `http://localhost:${process.env.PORT || 4000}/api/outlook/callback`,
    configured: Boolean(clientId && clientSecret),
    syncIntervalMs: Number(process.env.MAIL_SYNC_INTERVAL_MS || 5 * 60 * 1000),
  };
}

/** Where the browser goes to sign the mailbox in. */
export function authorizeUrl(state) {
  const s = outlookSettings();
  const params = new URLSearchParams({
    client_id: s.clientId,
    response_type: 'code',
    redirect_uri: s.redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    prompt: 'select_account',
  });
  return `${LOGIN}/${s.tenant}/oauth2/v2.0/authorize?${params}`;
}

async function tokenRequest(params) {
  const s = outlookSettings();
  const resp = await httpFetch(`${LOGIN}/${s.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: s.clientId,
      client_secret: s.clientSecret,
      scope: SCOPES,
      ...params,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Microsoft sign-in failed: ${data.error_description || data.error || resp.status}`);
  return data;
}

/** The one connected mailbox, tokens included. Null when none is connected. */
export async function loadAccount() {
  const { rows } = await query('SELECT * FROM mail_account ORDER BY connected_at DESC LIMIT 1');
  return rows[0] || null;
}

/** What the UI may see of the mailbox: never a token. */
export function publicAccount(account) {
  if (!account) return null;
  return {
    provider: account.provider,
    address: account.address,
    display_name: account.display_name,
    connected_at: account.connected_at,
    last_sync_at: account.last_sync_at,
    last_sync_error: account.last_sync_error,
    sync_cursor: account.sync_cursor,
  };
}

/** A valid access token for the account, refreshing (and persisting) when it is about to expire. */
export async function accessToken(account) {
  const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 2 * 60 * 1000) return account.access_token;
  if (!account.refresh_token) throw new Error('The Outlook connection has expired — connect the mailbox again');
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refresh_token });
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || account.refresh_token,
    expires_at: new Date(Date.now() + Number(data.expires_in || 3600) * 1000),
  };
  await query(
    'UPDATE mail_account SET access_token = $1, refresh_token = $2, expires_at = $3 WHERE id = $4',
    [next.access_token, next.refresh_token, next.expires_at, account.id],
  );
  Object.assign(account, next);
  return next.access_token;
}

/** One Graph call as the account. */
export async function graph(account, path, { method = 'GET', body, headers = {} } = {}) {
  const token = await accessToken(account);
  const resp = await httpFetch(`${GRAPH}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204 || resp.status === 202) return null;
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Outlook (${method} ${path}): ${data.error?.message || resp.status}`);
  return data;
}

/** Finish the sign-in: exchange the code, read who the mailbox is, keep the tokens. */
export async function completeConnect(code, userId) {
  const s = outlookSettings();
  const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: s.redirectUri });
  const probe = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: new Date(Date.now() + Number(data.expires_in || 3600) * 1000),
  };
  const me = await graph(probe, '/me?$select=displayName,mail,userPrincipalName');
  const address = String(me.mail || me.userPrincipalName || '').toLowerCase();
  if (!address) throw new Error('Microsoft did not say which mailbox was signed in');

  // One mailbox at a time: connecting replaces whatever was connected before.
  await query('DELETE FROM mail_account');
  const { rows } = await query(
    `INSERT INTO mail_account (provider, address, display_name, access_token, refresh_token, expires_at, scopes, connected_by)
     VALUES ('outlook', $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [address, me.displayName || null, probe.access_token, probe.refresh_token, probe.expires_at, SCOPES, userId || null],
  );
  return rows[0];
}

export async function disconnect() {
  await query('DELETE FROM mail_account');
}

/**
 * Send one message as the mailbox. The message is created as a draft first,
 * because that is what hands back its internet message id and conversation
 * id — the two things a reply can be matched on — and then sent.
 * `attachments` are `{ filename, content: Buffer, contentType }`.
 */
export async function sendViaOutlook(account, { to, name, subject, body, replyTo, attachments = [] }) {
  const draft = await graph(account, '/me/messages', {
    method: 'POST',
    body: {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: to, ...(name ? { name } : {}) } }],
      ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
      attachments: attachments.map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename,
        contentType: a.contentType || 'application/octet-stream',
        contentBytes: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content)).toString('base64'),
      })),
    },
  });
  await graph(account, `/me/messages/${encodeURIComponent(draft.id)}/send`, { method: 'POST' });
  return {
    sent: true,
    messageId: draft.internetMessageId || draft.id,
    conversationId: draft.conversationId || null,
    transport: 'outlook',
  };
}

/** Plain text out of a message body, whichever form Graph handed it over in. */
export function bodyText(body) {
  if (!body) return '';
  const content = String(body.content || '');
  if (String(body.contentType || '').toLowerCase() !== 'html') return content.trim();
  return content
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h\d)>/gi, '\n\n')
    .replace(/<\/(div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The inbox since a moment, oldest first, as plain messages. */
export async function listInbox(account, { since, top = 50 } = {}) {
  const params = new URLSearchParams({
    $select: 'id,internetMessageId,conversationId,from,subject,receivedDateTime,body,hasAttachments',
    $orderby: 'receivedDateTime asc',
    $top: String(top),
  });
  if (since) params.set('$filter', `receivedDateTime ge ${new Date(since).toISOString()}`);
  const data = await graph(account, `/me/mailFolders/inbox/messages?${params}`, {
    headers: { Prefer: 'outlook.body-content-type="text"' },
  });
  return (data?.value || []).map((m) => ({
    id: m.id,
    internetMessageId: m.internetMessageId || null,
    conversationId: m.conversationId || null,
    from: {
      email: String(m.from?.emailAddress?.address || '').toLowerCase(),
      name: m.from?.emailAddress?.name || null,
    },
    subject: m.subject || '',
    receivedAt: m.receivedDateTime,
    body: bodyText(m.body),
    hasAttachments: !!m.hasAttachments,
  }));
}
