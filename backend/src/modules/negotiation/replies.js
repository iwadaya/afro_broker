/*
 * The underwriters' replies, and what the AI makes of them.
 *
 * A submission goes out to named underwriters; what comes back is read from
 * the connected Outlook inbox (or logged by hand when a reply arrived some
 * other way) and tied to the underwriter it came from. Each reply is then
 * read by ChatGPT: what kind of answer it is — a quote, a decline, a question,
 * an acknowledgement — a one-line summary, the terms it carries, the questions
 * it asks, the deadline it mentions and what the broker should do next. The
 * reading is a *reading*, not a booking: the broker captures the quote on the
 * sheet, and the AI never moves the board. With no key configured a plain
 * keyword read stands in, so the flow works offline and in tests.
 */

import { query, withTransaction } from '../../db/pool.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { completeJson } from '../../lib/llm.js';
import { loadAccount, listInbox } from '../../integrations/outlook.js';

export const REPLY_KINDS = ['quote', 'decline', 'question', 'acknowledgement', 'other'];

export const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'summary', 'terms', 'questions', 'deadline', 'next_action'],
  properties: {
    kind: {
      type: 'string',
      enum: REPLY_KINDS,
      description: 'quote when terms or a line are offered; decline when the market will not support; question when information is asked for before terms; acknowledgement when it only confirms receipt; other otherwise.',
    },
    summary: { type: 'string', description: 'One or two sentences, in the underwriter\'s own terms, of what the reply says.' },
    terms: {
      type: 'array',
      description: 'Every term offered, one item per structure or layer named. Numbers exactly as written; null when not stated.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['structure', 'layer', 'premium', 'rate_pct', 'line_pct', 'commission_pct', 'subjectivities'],
        properties: {
          structure: { type: ['string', 'null'] },
          layer: { type: ['string', 'null'] },
          premium: { type: ['number', 'null'] },
          rate_pct: { type: ['number', 'null'], description: 'Rate, rate on line or rate on EGNPI, as a percentage.' },
          line_pct: { type: ['number', 'null'], description: 'The line or share offered, as a percentage.' },
          commission_pct: { type: ['number', 'null'] },
          subjectivities: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    questions: { type: 'array', items: { type: 'string' }, description: 'What the underwriter asks the broker for.' },
    deadline: { type: ['string', 'null'], description: 'Any date or validity the reply gives, as written.' },
    next_action: { type: 'string', description: 'What the broker should do next, in one sentence.' },
  },
};

const SYSTEM = [
  'You are a reinsurance treaty broker\'s assistant reading an underwriter\'s email reply to a renewal submission.',
  'You are given the submission context (cedant, class, period, the structures the market was asked to quote) and the reply.',
  'Rules:',
  '- Classify the reply, summarise it faithfully, and extract every term it states. Never invent a figure: a term the reply does not state is null.',
  '- Percentages as percentages (a 7.5% rate is 7.5), money as plain numbers in the reply\'s currency.',
  '- Quoted text from the broker\'s own email, signatures and disclaimers are not the reply.',
  '- next_action is one practical sentence: capture the quote on the sheet, answer the question, chase, or note the decline.',
].join('\n');

function buildPrompt(reply, context) {
  return JSON.stringify({
    submission: context ? {
      cedant: context.cedant || null,
      class: context.class || null,
      period: context.period || null,
      currency: context.currency || null,
      structures: context.structures || [],
      sent_to: context.recipient || null,
    } : null,
    reply: {
      from: reply.from_name ? `${reply.from_name} <${reply.from_email}>` : reply.from_email,
      market: reply.market_name || null,
      subject: reply.subject || null,
      received_at: reply.received_at || null,
      body: String(reply.body || '').slice(0, 12000),
    },
  }, null, 1);
}

const pct = (m) => (m ? Number(String(m[1]).replace(/,/g, '')) : null);

/** The offline read: keyword rules and the numbers next to them. */
export function heuristicRead(text) {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const declined = /\b(decline|declining|unable to (support|offer|participate|quote)|not (able|in a position) to (support|offer|participate|quote)|pass on this|will not be (participating|supporting|quoting))\b/.test(t);
  const quoted = /\b(quote|quoted|our terms|rate on line|\brol\b|premium of|line of|we can offer|pleased to offer|indicat(e|ion|ive)|subject to)\b/.test(t);
  const asked = /\?|\b(could you (clarify|confirm|provide|send)|please (provide|send|clarify|confirm)|we (would )?need)\b/.test(t);
  const acknowledged = /\b(thank you for|thanks for|received|acknowledg|will revert|come back to you)\b/.test(t);
  const kind = declined ? 'decline' : quoted ? 'quote' : asked ? 'question' : acknowledged ? 'acknowledgement' : 'other';

  const firstLines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !/^(dear|hi|hello)\b/i.test(l) && !/^>/.test(l));
  const summary = firstLines.slice(0, 2).join(' ').slice(0, 240) || raw.slice(0, 240);

  const terms = [];
  if (kind === 'quote') {
    const rate = pct(/(?:rate on line|rate|rol)\D{0,12}([\d.,]+)\s*%/i.exec(raw)) ?? pct(/([\d.,]+)\s*%\s*(?:rate on line|rol|rate)/i.exec(raw));
    const line = pct(/(?:line|share)\D{0,12}([\d.,]+)\s*%/i.exec(raw)) ?? pct(/([\d.,]+)\s*%\s*(?:line|share)/i.exec(raw));
    const premium = pct(/premium\D{0,16}([\d,]+(?:\.\d+)?)/i.exec(raw));
    const commission = pct(/commission\D{0,12}([\d.,]+)\s*%/i.exec(raw));
    if (rate != null || line != null || premium != null || commission != null) {
      terms.push({ structure: null, layer: null, premium, rate_pct: rate, line_pct: line, commission_pct: commission, subjectivities: [] });
    }
  }
  const questions = kind === 'question'
    ? raw.split(/\n|(?<=\?)/).map((l) => l.trim()).filter((l) => l.endsWith('?')).slice(0, 5)
    : [];
  const deadline = (/\b(valid (?:until|to|for)[^.\n]*|by \d{1,2}(?:st|nd|rd|th)? [A-Z][a-z]+[^.\n]*|deadline[^.\n]*)/i.exec(raw) || [])[0] || null;
  const next = {
    quote: 'Capture the quoted terms on the sheet against the structure they answer.',
    decline: 'Note the decline on the board and consider who replaces the capacity.',
    question: 'Answer the underwriter\'s questions and chase for terms.',
    acknowledgement: 'Nothing yet — chase if no terms arrive by the deadline.',
    other: 'Read the reply and decide what it needs.',
  }[kind];
  return { kind, summary, terms, questions, deadline, next_action: next };
}

/** Read one reply — ChatGPT when configured, the keyword read otherwise. */
export async function readReply(reply, context, clients) {
  try {
    const { provider, model, data } = await completeJson({
      system: SYSTEM,
      prompt: buildPrompt(reply, context),
      schema: READ_SCHEMA,
      schemaName: 'underwriter_reply',
      maxTokens: 4000,
      effort: 'low',
    }, clients);
    return { ...data, source: 'ai', provider, model, read_at: new Date().toISOString() };
  } catch (err) {
    return { ...heuristicRead(reply.body), source: 'fallback', provider: null, model: null, reason: err.message, read_at: new Date().toISOString() };
  }
}

// ------------------------------------------------------------- matching ---

/** Emails from the mailbox itself are ours, not replies. */
const isSelf = (email, account) => account?.address && String(email || '').toLowerCase() === String(account.address).toLowerCase();

/**
 * Which recipient of a sent submission an inbox message answers. In order:
 * the conversation the send started; the reference tag in the subject with
 * the sender's address; the tag alone; the sender's address alone (newest
 * submission first). Pure, so it can be tested without an inbox.
 */
export function matchInbound(message, candidates) {
  const email = String(message.from?.email || '').toLowerCase();
  const subject = String(message.subject || '');
  const byConversation = message.conversationId
    && candidates.find((c) => c.conversation_id && c.conversation_id === message.conversationId);
  if (byConversation) return { candidate: byConversation, how: 'conversation' };
  const tagged = candidates.filter((c) => c.reference_tag && subject.includes(c.reference_tag));
  const byTagAndEmail = tagged.find((c) => c.email === email);
  if (byTagAndEmail) return { candidate: byTagAndEmail, how: 'tag+sender' };
  if (tagged.length) return { candidate: { ...tagged[0], recipient_id: null, market_id: null }, how: 'tag' };
  const byEmail = candidates.find((c) => c.email === email);
  if (byEmail) return { candidate: byEmail, how: 'sender' };
  return null;
}

/** Every underwriter a sent submission went to — what an inbox message is matched against. */
async function sentRecipients(runner = { query }) {
  const { rows } = await runner.query(
    `SELECT r.id AS recipient_id, r.submission_id, r.market_id, lower(r.email) AS email, r.conversation_id,
            s.placement_id, s.reference_tag, s.sent_at
     FROM negotiation_submission_recipient r
     JOIN negotiation_submission s ON s.id = r.submission_id
     WHERE s.status = 'sent' AND r.status = 'sent'
     ORDER BY s.sent_at DESC`,
  );
  return rows;
}

// -------------------------------------------------------------- recording ---

/** The submission's context for the reader: what the underwriter was asked. */
export async function replyContext(submissionId, recipientId) {
  const { rows } = await query(
    `SELECT s.id, s.reference_tag, p.class, p.currency, p.inception, p.expiry, p.quote_structures, c.name AS cedant
     FROM negotiation_submission s
     JOIN placement p ON p.id = s.placement_id
     LEFT JOIN cedant c ON c.id = p.cedant_id
     WHERE s.id = $1`,
    [submissionId],
  );
  const s = rows[0];
  if (!s) return null;
  const { rows: rec } = recipientId
    ? await query('SELECT r.name, r.email, m.name AS market_name FROM negotiation_submission_recipient r JOIN market m ON m.id = r.market_id WHERE r.id = $1', [recipientId])
    : { rows: [] };
  const day = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
  return {
    cedant: s.cedant,
    class: s.class,
    currency: s.currency,
    period: `${day(s.inception)} to ${day(s.expiry)}`,
    structures: (s.quote_structures || []).map((st, i) => ({
      structure: `Structure ${i + 1}`,
      basis: st.basis,
      layers: st.basis === 'PROP'
        ? [{ label: 'whole', ...(st.prop || {}) }]
        : (st.layers || []).map((l) => ({ label: l.name, limit: l.limit, attachment: l.attachment, premium: l.premium, rate_pct: l.rate_pct })),
    })),
    recipient: rec[0] ? { name: rec[0].name, email: rec[0].email, market: rec[0].market_name } : null,
  };
}

/**
 * Store a reply and read it. Skips a message already recorded (same internet
 * message id). Marks the recipient replied and counts the reply against it.
 */
export async function recordReply(input, { clients, userId } = {}) {
  if (input.message_id) {
    const { rows } = await query('SELECT id FROM negotiation_reply WHERE message_id = $1', [input.message_id]);
    if (rows[0]) return { reply: null, duplicate: true };
  }
  const context = await replyContext(input.submission_id, input.recipient_id);
  const marketName = context?.recipient?.market || null;
  const read = await readReply({ ...input, market_name: marketName }, context, clients);

  const reply = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO negotiation_reply
         (submission_id, recipient_id, placement_id, market_id, from_email, from_name, subject, body,
          received_at, message_id, conversation_id, source, kind, ai_read)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10,$11,$12,$13,$14)
       RETURNING *`,
      [input.submission_id, input.recipient_id || null, input.placement_id, input.market_id || null,
        String(input.from_email).toLowerCase(), input.from_name || null, input.subject || null, input.body,
        input.received_at || null, input.message_id || null, input.conversation_id || null,
        input.source || 'manual', read.kind, JSON.stringify(read)],
    );
    if (input.recipient_id) {
      await client.query(
        `UPDATE negotiation_submission_recipient
            SET reply_status = 'replied', reply_count = reply_count + 1,
                replied_at = COALESCE(replied_at, $2::timestamptz, now())
          WHERE id = $1`,
        [input.recipient_id, input.received_at || null],
      );
    }
    await audit({
      entityType: 'negotiation_submission', entityId: input.submission_id, action: 'reply',
      userId: userId || null,
      detail: { from: input.from_email, kind: read.kind, source: input.source || 'manual', read: read.source },
    }, client);
    return rows[0];
  });
  return { reply, duplicate: false };
}

/** A reply that arrived outside the mailbox, pasted in by the broker. */
export async function logManualReply(submissionId, input, user, clients) {
  const { rows: subRows } = await query(
    'SELECT id, placement_id, status FROM negotiation_submission WHERE id = $1', [submissionId],
  );
  const submission = subRows[0];
  if (!submission) throw new NotFoundError('Submission');
  if (submission.status !== 'sent') throw new ValidationError('Replies are logged against a submission that has gone out');
  const email = String(input.from_email || '').trim().toLowerCase();
  const { rows: recipients } = await query(
    'SELECT id, market_id, email, name FROM negotiation_submission_recipient WHERE submission_id = $1', [submissionId],
  );
  const recipient = input.recipient_id
    ? recipients.find((r) => r.id === input.recipient_id)
    : recipients.find((r) => String(r.email).toLowerCase() === email);
  if (input.recipient_id && !recipient) throw new NotFoundError('Recipient');
  const { reply } = await recordReply({
    submission_id: submissionId,
    recipient_id: recipient?.id || null,
    placement_id: submission.placement_id,
    market_id: recipient?.market_id || null,
    from_email: email || recipient?.email,
    from_name: input.from_name || recipient?.name || null,
    subject: input.subject || null,
    body: input.body,
    received_at: input.received_at || null,
    source: 'manual',
  }, { clients, userId: user.id });
  return getReply(reply.id);
}

const REPLY_SELECT = `
  SELECT r.*, m.name AS market_name, rc.name AS recipient_name,
         s.subject AS submission_subject, s.pack_version, s.reference_tag, hu.name AS handled_by_name
  FROM negotiation_reply r
  LEFT JOIN market m ON m.id = r.market_id
  LEFT JOIN negotiation_submission_recipient rc ON rc.id = r.recipient_id
  JOIN negotiation_submission s ON s.id = r.submission_id
  LEFT JOIN users hu ON hu.id = r.handled_by`;

export async function getReply(id) {
  const { rows } = await query(`${REPLY_SELECT} WHERE r.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Reply');
  return rows[0];
}

/**
 * The placement's responses: every reply newest first, and where each
 * underwriter of each sent submission stands (awaiting or replied, and what
 * kind of reply came last).
 */
export async function listReplies(placementId) {
  const [{ rows: replies }, { rows: recipients }] = await Promise.all([
    query(`${REPLY_SELECT} WHERE r.placement_id = $1 ORDER BY r.received_at DESC`, [placementId]),
    query(
      `SELECT r.id AS recipient_id, r.submission_id, r.market_id, m.name AS market_name, r.name, r.email,
              r.status AS delivery, r.sent_at, r.reply_status, r.reply_count, r.replied_at, s.pack_version, s.sent_at AS submission_sent_at,
              (SELECT kind FROM negotiation_reply x WHERE x.recipient_id = r.id ORDER BY x.received_at DESC LIMIT 1) AS last_kind,
              (SELECT ai_read->>'summary' FROM negotiation_reply x WHERE x.recipient_id = r.id ORDER BY x.received_at DESC LIMIT 1) AS last_summary
       FROM negotiation_submission_recipient r
       JOIN negotiation_submission s ON s.id = r.submission_id
       JOIN market m ON m.id = r.market_id
       WHERE s.placement_id = $1 AND s.status = 'sent'
       ORDER BY s.sent_at DESC, m.name`,
      [placementId],
    ),
  ]);
  return {
    replies,
    recipients,
    summary: {
      sent_to: recipients.length,
      replied: recipients.filter((r) => r.reply_status === 'replied').length,
      awaiting: recipients.filter((r) => r.reply_status !== 'replied').length,
      quotes: recipients.filter((r) => r.last_kind === 'quote').length,
      declines: recipients.filter((r) => r.last_kind === 'decline').length,
      questions: recipients.filter((r) => r.last_kind === 'question').length,
      unhandled: replies.filter((r) => !r.handled).length,
    },
  };
}

export async function markHandled(id, user, handled = true) {
  const { rowCount } = await query(
    `UPDATE negotiation_reply SET handled = $2, handled_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
            handled_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1`,
    [id, handled, user.id],
  );
  if (!rowCount) throw new NotFoundError('Reply');
  return getReply(id);
}

/** Read a reply again (a key configured since, or a better read wanted). */
export async function rereadReply(id, clients) {
  const reply = await getReply(id);
  const context = await replyContext(reply.submission_id, reply.recipient_id);
  const read = await readReply({ ...reply, market_name: reply.market_name }, context, clients);
  await query('UPDATE negotiation_reply SET kind = $2, ai_read = $3 WHERE id = $1', [id, read.kind, JSON.stringify(read)]);
  return getReply(id);
}

// ------------------------------------------------------------------ sync ---

let syncing = false;

/**
 * Read the connected inbox for replies. Every message since the cursor is
 * matched against the underwriters of sent submissions; a match is recorded
 * and read, the rest are left alone. Returns what happened, and records the
 * outcome on the account so the UI can show when the inbox was last read.
 */
export async function syncInbox({ clients, account: given } = {}) {
  const account = given || await loadAccount();
  if (!account) return { skipped: 'no_mailbox', checked: 0, matched: 0, recorded: 0 };
  if (syncing) return { skipped: 'in_progress', checked: 0, matched: 0, recorded: 0 };
  syncing = true;
  try {
    const since = account.sync_cursor
      ? new Date(new Date(account.sync_cursor).getTime() - 60 * 1000) // a minute of overlap; duplicates are skipped by id
      : new Date(new Date(account.connected_at).getTime() - 7 * 24 * 60 * 60 * 1000);
    const messages = await listInbox(account, { since });
    const candidates = await sentRecipients();
    let matched = 0;
    let recorded = 0;
    let cursor = account.sync_cursor ? new Date(account.sync_cursor) : null;
    for (const m of messages) {
      const at = new Date(m.receivedAt);
      if (!cursor || at > cursor) cursor = at;
      if (isSelf(m.from.email, account)) continue;
      const hit = matchInbound(m, candidates);
      if (!hit) continue;
      matched += 1;
      const { duplicate } = await recordReply({
        submission_id: hit.candidate.submission_id,
        recipient_id: hit.candidate.recipient_id,
        placement_id: hit.candidate.placement_id,
        market_id: hit.candidate.market_id,
        from_email: m.from.email,
        from_name: m.from.name,
        subject: m.subject,
        body: m.body || '(no text)',
        received_at: m.receivedAt,
        message_id: m.internetMessageId || m.id,
        conversation_id: m.conversationId,
        source: 'outlook',
      }, { clients });
      if (!duplicate) recorded += 1;
    }
    await query(
      'UPDATE mail_account SET sync_cursor = $2, last_sync_at = now(), last_sync_error = NULL WHERE id = $1',
      [account.id, cursor],
    );
    return { checked: messages.length, matched, recorded, cursor };
  } catch (err) {
    await query('UPDATE mail_account SET last_sync_at = now(), last_sync_error = $2 WHERE id = $1', [account.id, err.message]).catch(() => {});
    throw err;
  } finally {
    syncing = false;
  }
}

/** Keep reading the inbox while the server runs. Returns the stop function. */
export function startInboxPolling(intervalMs) {
  const tick = () => syncInbox().catch((e) => console.warn(`[outlook] inbox sync failed: ${e.message}`));
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  return () => clearInterval(timer);
}
