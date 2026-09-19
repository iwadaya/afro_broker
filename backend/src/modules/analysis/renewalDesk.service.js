/*
 * The renewal desk's market submission — the uploaded pack going to market
 * from its verified summary.
 *
 * It rides the existing submission machinery rather than a second pipeline:
 * the same negotiation_submission row and recipients, the same four-eyes
 * release (the broker who drafts never sends; an underwriter or admin
 * releases it), the same mailer and Outlook integration, the same register
 * and audit trail, the same inbox for the replies. What is the desk's own is
 * the source — the analysis, not a built pack — the template drafted from
 * the verified summary, the attachments, the panel pre-populated from last
 * year's signed lines, and the reminder three days before the deadline.
 *
 * The gate is here: nothing is created while the summary is unverified.
 */

import { query, withTransaction } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { createApproval } from '../../lib/approvals.js';
import { sendMail, resolveTransport } from '../../integrations/mailer.js';
import {
  resolveRecipients, writeRecipients, readRecipients, referenceTag,
} from '../negotiation/submission.service.js';
import {
  deskSubject, renderDeskEmail, renderReminder, defaultDeadline, reminderDue, isoDate,
} from './renewalDesk.email.js';
import { describeAttachments } from './renewalDesk.attachments.js';

const DOC_COLUMNS = 'id, analysis_id, role, filename, mime_type, size_bytes, created_at';

async function loadAnalysis(id) {
  const { rows } = await query(
    `SELECT a.*, u.name AS verified_by_name
       FROM renewal_pack_analysis a LEFT JOIN users u ON u.id = a.verified_by
      WHERE a.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Renewal pack analysis');
  return rows[0];
}

async function loadDocuments(analysisId) {
  const { rows } = await query(
    `SELECT ${DOC_COLUMNS} FROM renewal_pack_analysis_document WHERE analysis_id = $1 ORDER BY created_at`,
    [analysisId],
  );
  return rows;
}

async function loadPlacement(id) {
  const { rows } = await query(
    `SELECT p.*, c.name AS cedant_name
       FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0] || null;
}

// ------------------------------------------------------------------ panel ---

/**
 * The panel by reinsurer. Pre-populated from the prior year's signed lines
 * — the placement this one renews, via renewal_of — and each market's
 * standing line across the book, with the primary underwriter held on the
 * register. With no prior year, every reinsurer on the register is offered.
 *
 * Every row says why it is selectable or not: a market with no underwriter
 * on file cannot be written to, and a market on the declined-security list
 * is withdrawn.
 */
async function buildPanel(placement) {
  const prior = placement.renewal_of
    ? (await query('SELECT id, reference, inception FROM placement WHERE id = $1', [placement.renewal_of])).rows[0] || null
    : null;

  const [reinsurers, contacts, standing, priorLines] = await Promise.all([
    query(`SELECT id, name, rating, domicile, security_status FROM market WHERE type = 'reinsurer' ORDER BY name`),
    query(
      `SELECT DISTINCT ON (market_id) market_id, id, name, email
         FROM market_contact WHERE active
        ORDER BY market_id, is_primary DESC, name`,
    ),
    query(
      `SELECT market_id, AVG(COALESCE(signed_pct, written_pct))::float8 AS standard_line, COUNT(*)::int AS lines
         FROM line WHERE status IN ('WRITTEN', 'SIGNED', 'AGREED') GROUP BY market_id`,
    ),
    prior
      ? query(
        `SELECT l.market_id,
                AVG(COALESCE(l.signed_pct, l.written_pct)) FILTER (WHERE l.status <> 'DECLINED')::float8 AS prior_line,
                BOOL_AND(l.status = 'DECLINED') AS declined,
                COUNT(*)::int AS layers
           FROM line l JOIN layer ly ON ly.id = l.layer_id
          WHERE ly.placement_id = $1
          GROUP BY l.market_id`,
        [prior.id],
      )
      : Promise.resolve({ rows: [] }),
  ]);

  const contactOf = new Map(contacts.rows.map((c) => [c.market_id, c]));
  const standingOf = new Map(standing.rows.map((s) => [s.market_id, s]));
  const priorOf = new Map(priorLines.rows.map((p) => [p.market_id, p]));

  const row = (m) => {
    const p = priorOf.get(m.id);
    const wrote = Boolean(p && !p.declined && (p.prior_line || 0) > 0);
    const withdrawn = m.security_status === 'declined';
    const contact = contactOf.get(m.id) || null;
    return {
      market_id: m.id,
      name: m.name,
      rating: m.rating,
      domicile: m.domicile,
      security_status: m.security_status,
      contact: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
      standard_line: standingOf.get(m.id)?.standard_line ?? null,
      prior_line: p?.prior_line ?? null,
      prior_declined: Boolean(p?.declined),
      wrote_last_year: wrote,
      withdrawn,
      selectable: Boolean(contact) && !withdrawn,
      // The default selection: every market that wrote last year and is not withdrawn.
      default_selected: wrote && !withdrawn && Boolean(contact),
    };
  };

  const onPanel = reinsurers.rows.filter((m) => priorOf.has(m.id)).map(row)
    .sort((a, b) => (b.prior_line || 0) - (a.prior_line || 0) || a.name.localeCompare(b.name));
  const rest = reinsurers.rows.filter((m) => !priorOf.has(m.id)).map(row);

  return {
    // `lines` says whether the prior year has a panel to pre-populate from at
    // all — a renewal whose expiring placement was never lined up offers the
    // register, and says so.
    prior_year: prior
      ? { id: prior.id, reference: prior.reference, year: isoDate(prior.inception)?.slice(0, 4) || null, lines: priorLines.rows.length }
      : null,
    markets: [...onPanel, ...rest],
  };
}

// ------------------------------------------------------------- submission ---

/** The latest desk submission on an analysis, with its recipients; cancelled ones are history. */
export async function latestDeskSubmission(analysisId) {
  const { rows } = await query(
    `SELECT s.*, u.name AS created_by_name, a.name AS approved_by_name
       FROM negotiation_submission s
       JOIN users u ON u.id = s.created_by
       LEFT JOIN users a ON a.id = s.approved_by
      WHERE s.analysis_id = $1 AND s.status <> 'cancelled'
      ORDER BY s.created_at DESC LIMIT 1`,
    [analysisId],
  );
  if (!rows[0]) return null;
  const recipients = await readRecipients({ query }, rows[0].id);
  return { ...rows[0], recipients, delivered: recipients.filter((r) => r.status === 'sent').length };
}

/** The submission as the tab strip and the detail read it: state, not content. */
export function summariseSubmission(s) {
  if (!s) return null;
  return {
    id: s.id, status: s.status, sent_at: s.sent_at, response_deadline: isoDate(s.response_deadline),
    created_by: s.created_by, created_by_name: s.created_by_name, approved_by_name: s.approved_by_name,
    recipients: s.recipients.length, delivered: s.delivered, reject_reason: s.reject_reason,
  };
}

/**
 * Everything the market email tab needs, and what stands in the way: the
 * gate (a verified summary, a linked placement), the panel, the drafted
 * template, the attachments, and the submission already on the record.
 */
export async function deskContext(analysisId, user) {
  const analysis = await loadAnalysis(analysisId);
  const documents = await loadDocuments(analysisId);
  const placement = analysis.placement_id ? await loadPlacement(analysis.placement_id) : null;

  const blockers = [];
  if (!analysis.result) {
    blockers.push('Run the AI analysis before going to market — the email is drafted from the verified summary');
  } else if (!analysis.verified_at) {
    blockers.push('The summary must be verified by a broker before anything goes to market');
  }
  if (!placement) {
    blockers.push('Link this pack to its placement on the Renewal pack tab — the submission goes out from the placement it belongs to');
  }

  const warnings = [];
  const transport = await resolveTransport();
  if (transport.transport === 'stub') {
    warnings.push('No Outlook mailbox is connected — the email is recorded here but nothing is delivered. Connect Outlook on the Admin page.');
  }

  const panel = placement ? await buildPanel(placement) : { prior_year: null, markets: [] };
  const deadline = defaultDeadline();
  const template = analysis.result
    ? {
      subject: deskSubject({ analysis, placement }),
      body: renderDeskEmail({ analysis, placement, documents, deadline, author: user }),
      response_deadline: deadline,
    }
    : null;
  const attachments = analysis.result ? await describeAttachments(analysis, documents) : [];
  const submission = await latestDeskSubmission(analysisId);

  return {
    analysis: {
      id: analysis.id, cedant_name: analysis.cedant_name, treaty_type: analysis.treaty_type,
      class_of_business: analysis.class_of_business, verified_at: analysis.verified_at,
      verified_by_name: analysis.verified_by_name,
    },
    placement: placement && {
      id: placement.id, reference: placement.reference, status: placement.status,
      inception: isoDate(placement.inception), expiry: isoDate(placement.expiry),
      currency: placement.currency, cedant_name: placement.cedant_name,
    },
    ready: blockers.length === 0,
    blockers,
    warnings,
    mail_transport: transport.transport,
    mail_from: transport.from,
    prior_year: panel.prior_year,
    panel: panel.markets,
    template,
    attachments,
    submission,
  };
}

/**
 * The broker's "Send": the covering email as edited, to the chosen
 * underwriters, awaiting the second pair of eyes. The broker has read it —
 * they wrote it — so it goes straight to pending approval; the release is
 * the existing one, which mails each underwriter individually with the
 * pack, the verified summary and the schedule attached.
 */
export async function createDeskSubmission(analysisId, input, user) {
  const ctx = await deskContext(analysisId, user);
  if (!ctx.ready) throw new ConflictError(ctx.blockers.join('; '));
  if (ctx.submission?.status === 'pending_approval') {
    throw new ConflictError('A submission is already awaiting release — have it released, or withdraw it, before sending another');
  }
  const recipients = await resolveRecipients({ query }, input.recipients);
  const deadline = input.response_deadline || ctx.template.response_deadline;

  return withTransaction(async (client) => {
    const tag = referenceTag();
    const subject = `${String(input.subject || ctx.template.subject).trim()} [${tag}]`;
    const body = input.body || ctx.template.body;
    const { rows } = await client.query(
      `INSERT INTO negotiation_submission
         (placement_id, analysis_id, subject, body, ai_meta, attach_pack,
          broker_reviewed, reviewed_by, reviewed_at, status, created_by, reference_tag, response_deadline)
       VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,$6,now(),'pending_approval',$6,$7,$8)
       RETURNING *`,
      [ctx.placement.id, analysisId, subject, body,
        JSON.stringify({ source: 'desk', template: 'renewal-desk', generated_at: new Date().toISOString() }),
        user.id, tag, deadline],
    );
    const submission = rows[0];
    await writeRecipients(client, submission.id, recipients);
    await createApproval(client, {
      actionType: 'submission_send', entityType: 'negotiation_submission', entityId: submission.id,
      proposedBy: user.id, detail: { subject, recipients: recipients.length, source: 'desk' },
    });
    await audit({
      entityType: 'negotiation_submission', entityId: submission.id, action: 'draft', userId: user.id,
      detail: { placement_id: ctx.placement.id, analysis_id: analysisId, recipients: recipients.length, source: 'desk' },
    }, client);
    await audit({
      entityType: 'negotiation_submission', entityId: submission.id, action: 'request_approval', userId: user.id,
      detail: { recipients: recipients.length },
    }, client);
    await audit({
      entityType: 'renewal_pack_analysis', entityId: analysisId, action: 'submit_to_market', userId: user.id,
      detail: { submission_id: submission.id, recipients: recipients.length, response_deadline: deadline },
    }, client);
    return { ...submission, recipients: await readRecipients(client, submission.id) };
  });
}

// -------------------------------------------------------------- reminders ---

/**
 * The underwriters owed a reminder now: on a desk submission that went out,
 * within three days of its deadline, not yet replied, not yet reminded.
 */
export async function dueReminders(now = new Date()) {
  const { rows } = await query(
    `SELECT r.id AS recipient_id, r.name, r.email, r.reminded_at,
            s.id AS submission_id, s.subject, s.response_deadline, s.status,
            u.name AS author_name,
            EXISTS (SELECT 1 FROM negotiation_reply x WHERE x.recipient_id = r.id) AS replied
       FROM negotiation_submission_recipient r
       JOIN negotiation_submission s ON s.id = r.submission_id
       JOIN users u ON u.id = s.created_by
      WHERE s.analysis_id IS NOT NULL AND s.status = 'sent' AND s.response_deadline IS NOT NULL
        AND r.status = 'sent' AND r.reminded_at IS NULL`,
  );
  return rows.filter((r) => reminderDue({
    deadline: r.response_deadline, now, status: r.status, remindedAt: r.reminded_at, replied: r.replied,
  }));
}

/** Send every reminder that is due. Once per underwriter: reminded_at is set as each goes. */
export async function sendDueReminders({ now = new Date() } = {}) {
  const due = await dueReminders(now);
  let reminded = 0;
  for (const r of due) {
    const result = await sendMail({
      to: r.email,
      name: r.name,
      subject: `Reminder: ${r.subject}`,
      body: renderReminder({ submission: r, recipient: r, author: { name: r.author_name } }),
    });
    if (!result.sent) continue;
    await query('UPDATE negotiation_submission_recipient SET reminded_at = now() WHERE id = $1', [r.recipient_id]);
    await audit({
      entityType: 'negotiation_submission', entityId: r.submission_id, action: 'remind', userId: null,
      detail: { recipient_id: r.recipient_id, email: r.email, deadline: isoDate(r.response_deadline) },
    });
    reminded += 1;
  }
  return { due: due.length, reminded };
}

/** Run the reminder check on an interval (hourly by default). Returns a stop function. */
export function startReminderPolling(intervalMs = 60 * 60 * 1000) {
  const tick = () => sendDueReminders().catch((e) => console.warn(`[renewal desk] reminders failed: ${e.message}`));
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}
