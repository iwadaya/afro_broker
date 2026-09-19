/*
 * Taking the pack to market.
 *
 * The board (018) records that a market holds the pack. This is the step
 * before it: a covering email, drafted with AI commentary, read and edited by
 * the broker, and released by a second pair of eyes — which is what actually
 * emails the underwriters and puts them on the board.
 *
 * Integrity rules enforced here:
 *  - A submission is built on a *built* renewal pack and a draft wording that
 *    belongs to this placement. Whether the pack is approved and the wording
 *    issued is surfaced as a warning, not a block — that judgement is the
 *    broker's, but they have to see it.
 *  - Nothing machine-written goes out unread: `broker_reviewed` must be set,
 *    and any later edit to the subject or body clears it again.
 *  - Content and recipients freeze the moment approval is requested.
 *  - The drafter can never release their own submission; the releaser holds
 *    underwriter or admin.
 */

import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { createApproval, approve } from '../../lib/approvals.js';
import { negotiationBoard } from '../../domain/negotiation.js';
import { sendMail, resolveTransport } from '../../integrations/mailer.js';
import { packAttachments } from '../packs/packs.files.js';
import { draftCommentary } from './commentary.js';
import { renderSubmissionEmail, renderSubject, personalise } from './submissionEmail.js';
import { sendPack } from './negotiation.service.js';
import { deskAttachments } from '../analysis/renewalDesk.attachments.js';

const RELEASE_ROLES = ['underwriter', 'admin'];

const SUBMISSION_COLUMNS = `s.id, s.placement_id, s.pack_id, s.pack_version, s.analysis_id, s.response_deadline, s.wording_id,
  s.subject, s.body, s.ai_commentary, s.ai_meta, s.attach_pack, s.reference_tag,
  s.broker_reviewed, s.reviewed_by, s.reviewed_at, s.status, s.reject_reason,
  s.created_by, s.approved_by, s.approved_at, s.sent_at, s.created_at, s.updated_at`;

// ------------------------------------------------------------- the pieces ---

async function loadPlacement(placementId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT p.*, c.name AS cedant_name, c.domicile AS cedant_domicile
     FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id WHERE p.id = $1`,
    [placementId],
  );
  if (!rows[0]) throw new NotFoundError('Placement');
  return rows[0];
}

/** The pack being offered: the named one, else the approved, else the latest. */
async function resolvePack(placementId, packId, runner = { query }) {
  if (packId) {
    const { rows } = await runner.query(
      'SELECT * FROM renewal_pack WHERE id = $1 AND placement_id = $2', [packId, placementId],
    );
    if (!rows[0]) throw new NotFoundError('Renewal pack');
    return rows[0];
  }
  const { rows } = await runner.query(
    `SELECT * FROM renewal_pack WHERE placement_id = $1
     ORDER BY (status = 'approved') DESC, version DESC LIMIT 1`,
    [placementId],
  );
  return rows[0] || null;
}

/** The wording on offer: the named one, else the placement's most advanced. */
async function resolveWording(placementId, wordingId, runner = { query }) {
  const sql = wordingId
    ? [`SELECT d.*, (SELECT COUNT(*) FROM wording_draft_clause c WHERE c.draft_id = d.id) AS clause_count
        FROM wording_draft d WHERE d.id = $1 AND d.placement_id = $2`, [wordingId, placementId]]
    : [`SELECT d.*, (SELECT COUNT(*) FROM wording_draft_clause c WHERE c.draft_id = d.id) AS clause_count
        FROM wording_draft d
        WHERE d.placement_id = $1 AND d.status <> 'archived'
        ORDER BY (d.status = 'issued') DESC, (d.status = 'review') DESC, d.updated_at DESC LIMIT 1`, [placementId]];
  const { rows } = await runner.query(...sql);
  if (wordingId && !rows[0]) throw new NotFoundError('Wording draft');
  if (!rows[0]) return null;
  return { ...rows[0], clause_count: Number(rows[0].clause_count) };
}

/**
 * What a submission would be built from, and what stands in its way.
 * `blockers` stop a submission; `warnings` are shown to the broker beside it.
 */
export async function submissionContext(placementId, { pack_id, wording_id } = {}) {
  const placement = await loadPlacement(placementId);
  const [pack, wording] = await Promise.all([
    resolvePack(placementId, pack_id),
    resolveWording(placementId, wording_id),
  ]);
  const structures = negotiationBoard(placement.quote_structures || []);

  const blockers = [];
  if (!pack) blockers.push('Create a renewal pack on the Renewal Pack tab before going to market');
  if (pack && pack.status !== 'approved') {
    blockers.push(`Renewal pack v${pack.version} has not been approved — a Senior Broker approves it on the Renewal Pack tab before it goes to market`);
  }
  if (!wording) blockers.push('Draft a wording for this placement in the wording library before going to market');
  if (!structures.length) blockers.push('There are no structures to quote — build the structure first');

  const warnings = [];
  if (wording && wording.status !== 'issued') {
    warnings.push(`Wording “${wording.title}” is at ${wording.status}, not issued.`);
  }

  const transport = await resolveTransport();
  if (transport.transport === 'stub') {
    warnings.push('No Outlook mailbox is connected — the email is recorded here but nothing is delivered. Connect Outlook on the Admin page.');
  }

  return {
    placement,
    cedant: placement.cedant_name ? { name: placement.cedant_name, domicile: placement.cedant_domicile } : null,
    pack,
    wording,
    structures,
    blockers,
    warnings,
    ready: blockers.length === 0,
    mail_transport: transport.transport,
    mail_from: transport.from,
  };
}

/** The short reference carried in the subject, so a reply finds its submission. */
export const referenceTag = () => `BIQ-${randomBytes(4).toString('hex').toUpperCase()}`;

/** Markets with the underwriter addresses a submission can go to. */
export async function listUnderwriters() {
  const { rows } = await query(
    `SELECT m.id AS market_id, m.name AS market_name, m.rating, m.security_status,
            c.id AS contact_id, c.name, c.email, c.role, c.is_primary
     FROM market m
     LEFT JOIN market_contact c ON c.market_id = m.id AND c.active
     WHERE m.type = 'reinsurer'
     ORDER BY m.name, c.is_primary DESC, c.name`,
  );
  const markets = new Map();
  for (const r of rows) {
    if (!markets.has(r.market_id)) {
      markets.set(r.market_id, {
        market_id: r.market_id,
        market_name: r.market_name,
        rating: r.rating,
        security_status: r.security_status,
        contacts: [],
      });
    }
    if (r.contact_id) {
      markets.get(r.market_id).contacts.push({
        id: r.contact_id, name: r.name, email: r.email, role: r.role, is_primary: r.is_primary,
      });
    }
  }
  return [...markets.values()];
}

// ------------------------------------------------------------- recipients ---

/**
 * Validate the chosen underwriters and expand them into recipient rows. Every
 * one of them is approached for a lead quote, so each is a lead recipient.
 */
export async function resolveRecipients(client, selections) {
  if (!selections?.length) throw new ValidationError('Choose at least one underwriter to send to');
  const rows = [];
  const seen = new Set();

  for (const sel of selections) {
    const { rows: mRows } = await client.query('SELECT * FROM market WHERE id = $1', [sel.market_id]);
    const market = mRows[0];
    if (!market) throw new NotFoundError('Market');
    if (market.security_status === 'declined') {
      throw new ConflictError(`${market.name} is on the declined-security list and cannot be approached`);
    }

    let contact = null;
    if (sel.contact_id) {
      const { rows: cRows } = await client.query(
        'SELECT * FROM market_contact WHERE id = $1 AND market_id = $2', [sel.contact_id, sel.market_id],
      );
      contact = cRows[0];
      if (!contact) throw new NotFoundError('Underwriter contact');
      if (!contact.active) throw new ConflictError(`${contact.email} is no longer an active contact`);
    }

    const email = (sel.email || contact?.email || '').trim().toLowerCase();
    if (!email) {
      throw new ValidationError(`No underwriter email on file for ${market.name} — add one on the Markets register`);
    }
    if (seen.has(email)) continue;
    seen.add(email);

    rows.push({
      market_id: market.id,
      contact_id: contact?.id || null,
      name: sel.name || contact?.name || null,
      email,
      role: 'lead',
    });
  }
  return rows;
}

export async function writeRecipients(client, submissionId, recipients) {
  await client.query('DELETE FROM negotiation_submission_recipient WHERE submission_id = $1', [submissionId]);
  for (const r of recipients) {
    await client.query(
      `INSERT INTO negotiation_submission_recipient
         (submission_id, market_id, contact_id, name, email, role)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [submissionId, r.market_id, r.contact_id, r.name, r.email, r.role],
    );
  }
}

export async function readRecipients(runner, submissionId) {
  const { rows } = await runner.query(
    `SELECT r.*, m.name AS market_name, m.security_status
     FROM negotiation_submission_recipient r JOIN market m ON m.id = r.market_id
     WHERE r.submission_id = $1 ORDER BY m.name`,
    [submissionId],
  );
  return rows;
}

async function loadSubmission(runner, id, { forUpdate = false } = {}) {
  const { rows } = await runner.query(
    `SELECT ${SUBMISSION_COLUMNS} FROM negotiation_submission s WHERE s.id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Submission');
  return rows[0];
}

const withRecipients = async (runner, submission) => ({
  ...submission,
  recipients: await readRecipients(runner, submission.id),
});

// ---------------------------------------------------------- the lifecycle ---

/**
 * Draft a submission: pack + wording + drafted commentary, rendered into the
 * covering email and addressed to the chosen underwriters. Always starts
 * unreviewed — the broker reads it next.
 */
export async function createSubmission(placementId, input, user, clients) {
  const context = await submissionContext(placementId, input);
  if (!context.ready) throw new ConflictError(context.blockers.join('; '));

  const recipients = await resolveRecipients({ query }, input.recipients);

  // Drafting the commentary is a provider call, so it happens outside the
  // transaction that writes the submission.
  const drafted = input.commentary
    ? { commentary: input.commentary, source: 'broker', provider: null, model: null, generated_at: new Date().toISOString() }
    : await draftCommentary(context, clients);

  return withTransaction(async (client) => {
    const { placement, cedant, pack, wording, structures } = context;
    const tag = referenceTag();
    const subject = `${input.subject || renderSubject({ placement, cedant, pack })} [${tag}]`;
    const body = renderSubmissionEmail({
      placement, cedant, pack, structures, wording, commentary: drafted.commentary, author: user,
    });

    const { rows } = await client.query(
      `INSERT INTO negotiation_submission
         (placement_id, pack_id, pack_version, wording_id, subject, body,
          ai_commentary, ai_meta, attach_pack, created_by, reference_tag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${SUBMISSION_COLUMNS.replaceAll('s.', '')}`,
      [placementId, pack.id, pack.version, wording?.id || null,
        subject, body, drafted.commentary,
        JSON.stringify({
          source: drafted.source, provider: drafted.provider, model: drafted.model,
          generated_at: drafted.generated_at, ...(drafted.reason ? { reason: drafted.reason } : {}),
        }),
        input.attach_pack !== false, user.id, tag],
    );
    await writeRecipients(client, rows[0].id, recipients);
    await audit({
      entityType: 'negotiation_submission', entityId: rows[0].id, action: 'draft', userId: user.id,
      detail: {
        placement_id: placementId, pack_version: pack.version,
        wording: wording?.title || null, recipients: recipients.length, commentary: drafted.source,
      },
    }, client);
    return withRecipients(client, rows[0]);
  });
}

export async function listSubmissions(placementId) {
  const { rows } = await query(
    `SELECT ${SUBMISSION_COLUMNS}, u.name AS created_by_name, a.name AS approved_by_name,
            w.title AS wording_title,
            (SELECT COUNT(*) FROM negotiation_submission_recipient r WHERE r.submission_id = s.id) AS recipients,
            (SELECT COUNT(*) FROM negotiation_submission_recipient r
              WHERE r.submission_id = s.id AND r.status = 'sent') AS delivered
     FROM negotiation_submission s
     JOIN users u ON u.id = s.created_by
     LEFT JOIN users a ON a.id = s.approved_by
     LEFT JOIN wording_draft w ON w.id = s.wording_id
     WHERE s.placement_id = $1 ORDER BY s.created_at DESC`,
    [placementId],
  );
  return rows.map((r) => ({ ...r, recipients: Number(r.recipients), delivered: Number(r.delivered) }));
}

export async function getSubmission(id) {
  const submission = await loadSubmission({ query }, id);
  const recipients = await readRecipients({ query }, id);
  return {
    ...submission,
    recipients,
    // What the first underwriter on the list will actually read.
    preview: personalise(submission.body, {
      contactName: recipients[0]?.name,
      marketName: recipients[0]?.market_name,
    }),
  };
}

/**
 * Edit the draft. Changing what the market will read clears the broker's
 * confirmation unless it is given again in the same call.
 */
export async function updateSubmission(id, input, user) {
  return withTransaction(async (client) => {
    const submission = await loadSubmission(client, id, { forUpdate: true });
    if (submission.status !== 'draft') {
      throw new ConflictError(`This submission is ${submission.status.replace('_', ' ')}; only a draft can be edited`);
    }
    const changed = (input.subject != null && input.subject !== submission.subject)
      || (input.body != null && input.body !== submission.body);
    const reviewed = input.broker_reviewed != null
      ? input.broker_reviewed
      : (changed ? false : submission.broker_reviewed);

    const { rows } = await client.query(
      `UPDATE negotiation_submission
          SET subject = COALESCE($1::text, subject),
              body = COALESCE($2::text, body),
              attach_pack = COALESCE($3::boolean, attach_pack),
              broker_reviewed = $4,
              reviewed_by = CASE WHEN $4 THEN $5::uuid ELSE NULL END,
              reviewed_at = CASE WHEN $4 THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $6
        RETURNING ${SUBMISSION_COLUMNS.replaceAll('s.', '')}`,
      [input.subject ?? null, input.body ?? null, input.attach_pack ?? null, reviewed, user.id, id],
    );
    if (input.recipients) {
      await writeRecipients(client, id, await resolveRecipients(client, input.recipients));
    }
    await audit({
      entityType: 'negotiation_submission', entityId: id, action: 'edit', userId: user.id,
      detail: { content_changed: changed, broker_reviewed: reviewed },
    }, client);
    return withRecipients(client, rows[0]);
  });
}

/** Draft the commentary again and re-render the email, losing broker edits. */
export async function redraftCommentary(id, user, clients) {
  const submission = await loadSubmission({ query }, id);
  if (submission.status !== 'draft') {
    throw new ConflictError(`This submission is ${submission.status.replace('_', ' ')}; only a draft can be redrafted`);
  }
  const context = await submissionContext(submission.placement_id, {
    pack_id: submission.pack_id, wording_id: submission.wording_id,
  });
  const drafted = await draftCommentary(context, clients);

  return withTransaction(async (client) => {
    const body = renderSubmissionEmail({ ...context, commentary: drafted.commentary, author: user });
    const { rows } = await client.query(
      `UPDATE negotiation_submission
          SET body = $1, ai_commentary = $2, ai_meta = $3,
              broker_reviewed = FALSE, reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
        WHERE id = $4
        RETURNING ${SUBMISSION_COLUMNS.replaceAll('s.', '')}`,
      [body, drafted.commentary,
        JSON.stringify({
          source: drafted.source, provider: drafted.provider, model: drafted.model,
          generated_at: drafted.generated_at, ...(drafted.reason ? { reason: drafted.reason } : {}),
        }),
        id],
    );
    await audit({
      entityType: 'negotiation_submission', entityId: id, action: 'redraft', userId: user.id,
      detail: { commentary: drafted.source },
    }, client);
    return withRecipients(client, rows[0]);
  });
}

/** Ask for the second pair of eyes. Content and recipients freeze here. */
export async function requestApproval(id, user) {
  return withTransaction(async (client) => {
    const submission = await loadSubmission(client, id, { forUpdate: true });
    if (submission.status !== 'draft') {
      throw new ConflictError(`This submission is ${submission.status.replace('_', ' ')}; only a draft goes for approval`);
    }
    if (!submission.broker_reviewed) {
      throw new ConflictError('Read the drafted email and confirm it before sending it for approval');
    }
    const recipients = await readRecipients(client, id);
    if (!recipients.length) throw new ConflictError('Choose at least one underwriter to send to');

    const { rows } = await client.query(
      `UPDATE negotiation_submission SET status = 'pending_approval', reject_reason = NULL, updated_at = now()
        WHERE id = $1 RETURNING ${SUBMISSION_COLUMNS.replaceAll('s.', '')}`,
      [id],
    );
    await createApproval(client, {
      actionType: 'submission_send', entityType: 'negotiation_submission', entityId: id,
      proposedBy: user.id, detail: { subject: submission.subject, recipients: recipients.length },
    });
    await audit({
      entityType: 'negotiation_submission', entityId: id, action: 'request_approval', userId: user.id,
      detail: { recipients: recipients.length },
    }, client);
    return { ...rows[0], recipients };
  });
}

/** The pack itself, as the attachments the covering email carries: the
    approved version's Excel workbook and its PDF, both as stored when the
    version was cut. */
async function packAttachmentsFor(packId) {
  try {
    return await packAttachments(packId);
  } catch (e) {
    if (e.name === 'NotFoundError') return [];
    throw e;
  }
}

/**
 * Four-eyes release: check the second pair of eyes, email every underwriter,
 * then put those markets on the board holding this pack version.
 *
 * Delivery sits inside the transaction so a submission is never marked sent
 * without its per-recipient outcomes; if nothing could be delivered the whole
 * thing rolls back and stays awaiting approval, ready to retry.
 */
export async function approveAndSend(id, approver) {
  const submission = await loadSubmission({ query }, id);
  if (submission.status !== 'pending_approval') {
    throw new ConflictError(`This submission is ${submission.status.replace('_', ' ')}; only one awaiting approval can be released`);
  }
  // Rendering the attachments is slow and touches no rows — do it up front.
  // A submission built on a pack carries the pack's Excel and PDF; one the renewal desk
  // drafted from an uploaded pack carries the cedant's own pack, the
  // verified summary and the layer schedule.
  const attachments = submission.pack_id
    ? (submission.attach_pack ? await packAttachmentsFor(submission.pack_id) : [])
    : await deskAttachments(submission.analysis_id);

  const sent = await withTransaction(async (client) => {
    const current = await loadSubmission(client, id, { forUpdate: true });
    if (current.status !== 'pending_approval') throw new ConflictError('This submission has already been dealt with');

    // Four-eyes gate: drafter ≠ approver, and the approver holds the role.
    await approve(client, {
      actionType: 'submission_send', entityType: 'negotiation_submission', entityId: id,
      approver, allowedRoles: RELEASE_ROLES,
    });

    const recipients = await readRecipients(client, id);
    let delivered = 0;
    for (const r of recipients) {
      const result = await sendMail({
        to: r.email,
        name: r.name,
        subject: current.subject,
        body: personalise(current.body, { contactName: r.name, marketName: r.market_name }),
        attachments,
      });
      if (result.sent) delivered += 1;
      // The ids the send produced are what a reply is matched on later.
      await client.query(
        `UPDATE negotiation_submission_recipient
            SET status = $1, message_id = $2, error = $3,
                internet_message_id = $5, conversation_id = $6,
                sent_at = CASE WHEN $1 = 'sent' THEN now() ELSE NULL END
          WHERE id = $4`,
        [result.sent ? 'sent' : 'failed', result.messageId, result.error || null, r.id,
          result.sent ? result.messageId : null, result.sent ? result.conversationId || null : null],
      );
    }
    if (!delivered) {
      throw new ConflictError('Not one underwriter could be reached — the submission stays awaiting approval');
    }

    const { rows } = await client.query(
      `UPDATE negotiation_submission
          SET status = 'sent', approved_by = $1, approved_at = now(), sent_at = now(), updated_at = now()
        WHERE id = $2 RETURNING ${SUBMISSION_COLUMNS.replaceAll('s.', '')}`,
      [approver.id, id],
    );
    await audit({
      entityType: 'negotiation_submission', entityId: id, action: 'release', userId: approver.id,
      detail: { drafted_by: current.created_by, delivered, recipients: recipients.length },
    }, client);
    return { submission: rows[0], recipients };
  });

  // The markets now hold the pack: put them on the board at the version they
  // were emailed. Outside the transaction above so a board write can never
  // un-send an email that has already left. A desk submission carries no
  // built pack, so there is no version to hold — its responses are the
  // written lines on the layers, not the board.
  if (submission.pack_id) {
    const marketIds = [...new Set(sent.recipients.map((r) => r.market_id))];
    await sendPack(submission.placement_id, { market_ids: marketIds, pack_id: submission.pack_id }, approver.id);
  }

  return getSubmission(id);
}

/** Send it back to the broker with a reason (the other half of four-eyes). */
export async function rejectSubmission(id, approver, reason) {
  return withTransaction(async (client) => {
    const submission = await loadSubmission(client, id, { forUpdate: true });
    if (submission.status !== 'pending_approval') {
      throw new ConflictError(`This submission is ${submission.status.replace('_', ' ')}; there is nothing to review`);
    }
    if (submission.created_by === approver.id) {
      throw new ConflictError('Four-eyes: the drafter cannot review their own submission');
    }
    await client.query(
      `UPDATE approval SET status = 'rejected', approved_by = $1, resolved_at = now()
        WHERE action_type = 'submission_send' AND entity_type = 'negotiation_submission'
          AND entity_id = $2 AND status = 'pending'`,
      [approver.id, String(id)],
    );
    const { rows } = await client.query(
      `UPDATE negotiation_submission
          SET status = 'draft', reject_reason = $1, broker_reviewed = FALSE,
              reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
        WHERE id = $2 RETURNING ${SUBMISSION_COLUMNS.replaceAll('s.', '')}`,
      [reason || null, id],
    );
    await audit({
      entityType: 'negotiation_submission', entityId: id, action: 'reject', userId: approver.id,
      detail: { reason: reason || null },
    }, client);
    return withRecipients(client, rows[0]);
  });
}

/** The broker who drafted it (or an admin) withdraws it before it goes out. */
export async function cancelSubmission(id, user) {
  return withTransaction(async (client) => {
    const submission = await loadSubmission(client, id, { forUpdate: true });
    if (submission.status === 'sent') throw new ConflictError('A submission that has gone out cannot be withdrawn');
    if (submission.created_by !== user.id && user.role !== 'admin') {
      throw new ConflictError('Only the broker who drafted this submission, or an admin, can withdraw it');
    }
    await client.query(
      `UPDATE approval SET status = 'rejected', resolved_at = now()
        WHERE action_type = 'submission_send' AND entity_type = 'negotiation_submission'
          AND entity_id = $1 AND status = 'pending'`,
      [String(id)],
    );
    const { rows } = await client.query(
      `UPDATE negotiation_submission SET status = 'cancelled', updated_at = now()
        WHERE id = $1 RETURNING ${SUBMISSION_COLUMNS.replaceAll('s.', '')}`,
      [id],
    );
    await audit({ entityType: 'negotiation_submission', entityId: id, action: 'cancel', userId: user.id }, client);
    return rows[0];
  });
}
