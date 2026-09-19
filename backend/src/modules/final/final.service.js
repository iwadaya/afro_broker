/*
 * Final placement — the stage after the negotiation.
 *
 *  - Details: the final terms, one line per line of the structures placed.
 *    When we won the lead they are picked from the negotiation's quotes (a
 *    quote id per line, re-read here so the terms are the quote's, not the
 *    screen's); when another broker leads they are entered, with the type of
 *    treaty placed. Either way the lead broker and the lead reinsurer are
 *    captured — market intelligence.
 *  - Email: the firm order terms, with the approved renewal pack — its Excel
 *    and its PDF, as stored when the version was cut — or, with a stated
 *    reason, a renewal pack uploaded by hand, sent to the reinsurers and
 *    underwriters that will write the placement.
 *  - Lines: what each market wrote on each line, signed down to the order
 *    with the house signing engine when oversubscribed. A line may be read
 *    off a reinsurer's email by the AI, marked as such until a broker
 *    accepts or overrides it; every change to a line is kept. Finalising the
 *    shares marks them signed and sends each underwriter a confirmation
 *    carrying their written and signed lines.
 */

import { query, withTransaction } from '../../db/pool.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { computeSigning } from '../../domain/signingDown.js';
import { negotiationBoard, propCapacity } from '../../domain/negotiation.js';
import { sendMail, resolveTransport } from '../../integrations/mailer.js';
import { packAttachments, describePackAttachments } from '../packs/packs.files.js';
import { readLines } from './lines.llm.js';
import {
  renderFotSubject, renderFotEmail, renderConfirmationSubject, renderConfirmationEmail,
  renderDeclinatureSubject, renderDeclinatureEmail, linesBlock, personaliseFinal,
} from './final.email.js';

/** The three emails of the stage, by kind: their subject and body renderers. */
const EMAIL_KINDS = {
  fot: { subject: renderFotSubject, body: renderFotEmail, action: 'send_fot' },
  confirmation: { subject: renderConfirmationSubject, body: renderConfirmationEmail, action: 'send_confirmation' },
  declinature: { subject: renderDeclinatureSubject, body: renderDeclinatureEmail, action: 'send_declinature' },
};

const HOUSE = 'Universe Broking';

const numOrNull = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

// ---------------------------------------------------------------- reading ---

async function loadPlacement(placementId) {
  const { rows } = await query(
    `SELECT p.*, c.name AS cedant_name, c.domicile AS cedant_domicile
     FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id WHERE p.id = $1`,
    [placementId],
  );
  if (!rows[0]) throw new NotFoundError('Placement');
  return rows[0];
}

/** The stored record, or the empty draft a placement starts from. */
async function loadFinal(placementId) {
  const { rows } = await query(
    `SELECT f.*, m.name AS lead_reinsurer_register_name, cu.name AS confirmed_by_name
     FROM final_placement f
     LEFT JOIN market m ON m.id = f.lead_reinsurer_id
     LEFT JOIN users cu ON cu.id = f.confirmed_by
     WHERE f.placement_id = $1`,
    [placementId],
  );
  return rows[0] || null;
}

const emptyFinal = (placementId) => ({
  id: null, placement_id: placementId, lead_won: true, lead_broker: HOUSE,
  lead_reinsurer_id: null, lead_reinsurer_name: null, treaty_type: null, terms: [], notes: null, status: 'draft',
});

/** The term key of a board line: the structure and layer it answers. */
export const termKey = (line) => `s${line.structure_index}:${line.layer_index == null ? 'whole' : `l${line.layer_index}`}`;

/** The lines of the structures placed, with every quote captured against each. */
async function candidateLines(placement) {
  const { rows: quotes } = await query(
    `SELECT q.id, q.negotiation_id, q.structure_index, q.layer_index, q.status, q.rate_pct, q.premium, q.line_pct,
            q.commission_pct, q.validity, q.limit_amt, q.attachment, q.layer_name, q.kind, n.market_id, m.name AS market_name
     FROM negotiation_quote q
     JOIN negotiation n ON n.id = q.negotiation_id
     JOIN market m ON m.id = n.market_id
     WHERE n.placement_id = $1 AND q.market_structure_id IS NULL
     ORDER BY (q.kind = 'lead') DESC, m.name`,
    [placement.id],
  );
  return negotiationBoard(placement.quote_structures || []).flatMap((s) => s.lines.map((line) => ({
    key: termKey(line),
    structure_index: line.structure_index,
    structure_label: s.label,
    layer_index: line.layer_index,
    label: line.label,
    basis: line.basis,
    limit: line.limit ?? null,
    attachment: line.attachment ?? null,
    capacity: line.capacity ?? null,
    treaty_type: line.basis === 'PROP' ? (line.terms?.treaty_type || line.label) : null,
    asked: line.asked || {},
    quotes: quotes
      .filter((q) => q.structure_index === line.structure_index
        && (q.layer_index == null ? line.layer_index == null : q.layer_index === line.layer_index))
      .map((q) => ({
        id: q.id, market_id: q.market_id, market_name: q.market_name, status: q.status,
        // A lead quote can become the final terms; an indication is offered
        // after them, marked as what it is.
        kind: q.kind === 'indicative' ? 'indicative' : 'lead',
        premium: numOrNull(q.premium), rate_pct: numOrNull(q.rate_pct), line_pct: numOrNull(q.line_pct),
        commission_pct: numOrNull(q.commission_pct), validity: q.validity,
        limit: numOrNull(q.limit_amt), attachment: numOrNull(q.attachment),
      })),
  })));
}

/** The markets this placement has dealt with, with their underwriters. */
async function marketsWithContacts(placementId) {
  const { rows } = await query(
    `SELECT m.id AS market_id, m.name AS market_name, m.rating, m.security_status,
            n.role, n.status AS negotiation_status,
            c.id AS contact_id, c.name, c.email, c.role AS contact_role, c.is_primary
     FROM market m
     LEFT JOIN negotiation n ON n.market_id = m.id AND n.placement_id = $1
     LEFT JOIN market_contact c ON c.market_id = m.id AND c.active
     WHERE m.type = 'reinsurer'
     ORDER BY (n.id IS NOT NULL) DESC, m.name, c.is_primary DESC, c.name`,
    [placementId],
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.market_id)) {
      out.set(r.market_id, {
        market_id: r.market_id, market_name: r.market_name, rating: r.rating, security_status: r.security_status,
        on_negotiation: !!r.role, role: r.role, negotiation_status: r.negotiation_status, contacts: [],
      });
    }
    if (r.contact_id) out.get(r.market_id).contacts.push({ id: r.contact_id, name: r.name, email: r.email, role: r.contact_role, is_primary: r.is_primary });
  }
  return [...out.values()];
}

async function approvedPack(placementId) {
  const { rows } = await query(
    `SELECT id, version, status, summary FROM renewal_pack
     WHERE placement_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1`,
    [placementId],
  );
  return rows[0] || null;
}

async function listLines(finalId) {
  if (!finalId) return [];
  const { rows } = await query(
    `SELECT l.*, m.name AS market_name, c.name AS contact_name, c.email AS contact_email
     FROM final_placement_line l
     JOIN market m ON m.id = l.market_id
     LEFT JOIN market_contact c ON c.id = l.contact_id
     WHERE l.final_placement_id = $1 ORDER BY m.name, l.term_key`,
    [finalId],
  );
  return rows.map((r) => ({ ...r, written_pct: Number(r.written_pct), signed_pct: r.signed_pct == null ? null : Number(r.signed_pct) }));
}

/** The packs uploaded by hand at this stage, without their bytes. */
async function listPackUploads(finalId) {
  if (!finalId) return [];
  const { rows } = await query(
    `SELECT u.id, u.filename, u.mime_type, u.size_bytes, u.reason, u.created_at, us.name AS uploaded_by_name
       FROM final_placement_pack_upload u LEFT JOIN users us ON us.id = u.uploaded_by
      WHERE u.final_placement_id = $1 ORDER BY u.created_at DESC`,
    [finalId],
  );
  return rows;
}

/** Every change to a line, newest first — who, when, from what to what. */
async function listLineChanges(finalId) {
  if (!finalId) return [];
  const { rows } = await query(
    `SELECT ch.*, m.name AS market_name, u.name AS changed_by_name
       FROM final_placement_line_change ch
       JOIN market m ON m.id = ch.market_id
       LEFT JOIN users u ON u.id = ch.changed_by
      WHERE ch.final_placement_id = $1 ORDER BY ch.changed_at DESC, ch.id DESC`,
    [finalId],
  );
  return rows;
}

/** What a line change records either side of it. */
const lineState = (l) => (l ? {
  written_pct: Number(l.written_pct), signed_pct: l.signed_pct == null ? null : Number(l.signed_pct),
  to_stand: !!l.to_stand, status: l.status, source: l.source || 'broker', notes: l.notes || null,
} : null);

async function recordLineChange(client, { finalId, marketId, termKey, action, source, before, after, note, userId }) {
  await client.query(
    `INSERT INTO final_placement_line_change (final_placement_id, market_id, term_key, action, source, before_state, after_state, note, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [finalId, marketId, termKey, action, source, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, note || null, userId || null],
  );
}

async function listEmails(finalId) {
  if (!finalId) return [];
  const { rows } = await query(
    `SELECT e.*, u.name AS sent_by_name FROM final_placement_email e
     LEFT JOIN users u ON u.id = e.sent_by
     WHERE e.final_placement_id = $1 ORDER BY e.sent_at DESC`,
    [finalId],
  );
  return rows;
}

/** The signing of every term line: written totals, factor and signed lines. */
export function signingByTerm(lines, terms) {
  const keys = [...new Set([...(terms || []).map((t) => t.key), ...lines.map((l) => l.term_key)])];
  return Object.fromEntries(keys.map((key) => {
    const mine = lines.filter((l) => l.term_key === key);
    const signing = computeSigning(100, mine.map((l) => ({ id: l.id || `${l.market_id}:${key}`, written: Number(l.written_pct) || 0, toStand: !!l.to_stand })));
    return [key, {
      state: signing.state,
      written_total: signing.writtenTotal,
      signed_total: signing.signedTotal,
      signing_factor: signing.signingFactor,
      shortfall: signing.shortfall,
      signed: Object.fromEntries(signing.lines.map((l) => [l.id, l.signed])),
    }];
  }));
}

/** Everything the Final Placement tab shows. */
export async function getFinalPlacement(placementId) {
  const placement = await loadPlacement(placementId);
  const stored = await loadFinal(placementId);
  const final = stored || emptyFinal(placementId);
  const [candidates, markets, pack, lines, emails, packUploads, lineChanges] = await Promise.all([
    candidateLines(placement), marketsWithContacts(placementId), approvedPack(placementId),
    listLines(stored?.id), listEmails(stored?.id), listPackUploads(stored?.id), listLineChanges(stored?.id),
  ]);
  const transport = await resolveTransport();
  return {
    placement: {
      id: placement.id, reference: placement.reference, class: placement.class, currency: placement.currency,
      inception: placement.inception, expiry: placement.expiry, cedant: placement.cedant_name || null,
    },
    final: {
      ...final,
      lead_reinsurer_name: final.lead_reinsurer_name || final.lead_reinsurer_register_name || null,
      terms: final.terms || [],
    },
    candidates,
    markets,
    pack: pack && { id: pack.id, version: pack.version, summary: pack.summary, formats: ['xlsx', 'pdf'] },
    pack_uploads: packUploads,
    lines,
    line_changes: lineChanges,
    signing: signingByTerm(lines, final.terms || []),
    emails,
    mail_transport: transport.transport,
    mail_from: transport.from,
  };
}

// ---------------------------------------------------------------- details ---

/**
 * Save the details. A term picked from a quote is re-read from the quote
 * (the terms are the underwriter's, not the screen's); an entered term is
 * taken as given. The lead reinsurer is the market of the lead's quote when
 * none is named.
 */
export async function saveDetails(placementId, input, user) {
  const placement = await loadPlacement(placementId);
  const existing = await loadFinal(placementId);
  if (existing?.status === 'confirmed') throw new ConflictError('The placement is confirmed; the final terms are frozen');
  const candidates = await candidateLines(placement);
  const byKey = new Map(candidates.map((c) => [c.key, c]));

  const terms = [];
  for (const t of input.terms || []) {
    const line = byKey.get(t.key);
    if (!line) throw new ValidationError(`Unknown line "${t.key}" — the final terms follow the structures to quote`);
    const base = {
      key: line.key, structure_index: line.structure_index, structure_label: line.structure_label,
      layer_index: line.layer_index, label: line.label, basis: line.basis,
      limit: line.limit, attachment: line.attachment, capacity: line.capacity,
      treaty_type: line.basis === 'PROP' ? (t.treaty_type || line.treaty_type) : null,
    };
    if (t.quote_id) {
      const q = line.quotes.find((x) => x.id === t.quote_id);
      if (!q) throw new ValidationError(`Quote ${t.quote_id} was not captured against ${line.label}`);
      if (q.status === 'declined') throw new ValidationError(`${q.market_name} declined ${line.label}; a decline cannot be the final terms`);
      terms.push({
        ...base, quote_id: q.id, market_id: q.market_id, market_name: q.market_name,
        premium: q.premium, rate_pct: q.rate_pct, commission_pct: q.commission_pct, line_pct: q.line_pct,
        limit: q.limit ?? line.limit, attachment: q.attachment ?? line.attachment,
        notes: t.notes || null, source: 'quote',
      });
    } else {
      terms.push({
        ...base, quote_id: null, market_id: null, market_name: null,
        premium: numOrNull(t.premium), rate_pct: numOrNull(t.rate_pct), commission_pct: numOrNull(t.commission_pct), line_pct: null,
        limit: numOrNull(t.limit) ?? line.limit, attachment: numOrNull(t.attachment) ?? line.attachment,
        notes: t.notes || null, source: 'entered',
      });
    }
  }

  const leadWon = input.lead_won !== false;
  const leadFromQuotes = terms.find((t) => t.market_id);
  let leadReinsurerId = input.lead_reinsurer_id || (leadWon ? leadFromQuotes?.market_id || null : null);
  let leadReinsurerName = input.lead_reinsurer_name || null;
  if (leadReinsurerId) {
    const { rows } = await query('SELECT name FROM market WHERE id = $1', [leadReinsurerId]);
    if (!rows[0]) throw new NotFoundError('Lead reinsurer');
    leadReinsurerName = leadReinsurerName || rows[0].name;
  }
  const leadBroker = leadWon ? (input.lead_broker || HOUSE) : (input.lead_broker || null);
  if (!leadWon && !leadBroker) throw new ValidationError('Name the lead broker when another house leads the placement');

  const { rows } = await query(
    `INSERT INTO final_placement (placement_id, lead_won, lead_broker, lead_reinsurer_id, lead_reinsurer_name, treaty_type, terms, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (placement_id) DO UPDATE
       SET lead_won = EXCLUDED.lead_won, lead_broker = EXCLUDED.lead_broker,
           lead_reinsurer_id = EXCLUDED.lead_reinsurer_id, lead_reinsurer_name = EXCLUDED.lead_reinsurer_name,
           treaty_type = EXCLUDED.treaty_type, terms = EXCLUDED.terms, notes = EXCLUDED.notes, updated_at = now()
     RETURNING *`,
    [placementId, leadWon, leadBroker, leadReinsurerId, leadReinsurerName,
      input.treaty_type || null, JSON.stringify(terms), input.notes || null, user.id],
  );
  await audit({
    entityType: 'final_placement', entityId: rows[0].id, action: 'details', userId: user.id,
    detail: { lead_won: leadWon, lead_broker: leadBroker, lead_reinsurer: leadReinsurerName, terms: terms.length },
  });
  return getFinalPlacement(placementId);
}

// ------------------------------------------------------------------ email ---

async function contextFor(placementId) {
  const placement = await loadPlacement(placementId);
  const final = await loadFinal(placementId);
  if (!final) throw new ConflictError('Save the final terms on the Final Quote tab first');
  const pack = await approvedPack(placementId);
  const cedant = placement.cedant_name ? { name: placement.cedant_name } : null;
  return { placement, cedant, final: { ...final, lead_reinsurer_name: final.lead_reinsurer_name || final.lead_reinsurer_register_name }, pack };
}

/** The drafted email of either kind, for the broker to edit. */
export async function draftEmail(placementId, kind, user) {
  const ctx = await contextFor(placementId);
  if (kind === 'confirmation') {
    return { kind, subject: renderConfirmationSubject(ctx), body: renderConfirmationEmail({ ...ctx, author: user }), attach_pack: false, pack: ctx.pack };
  }
  return {
    kind: 'fot', subject: renderFotSubject(ctx), body: renderFotEmail({ ...ctx, author: user }),
    attach_pack: !!ctx.pack, pack: ctx.pack,
    // The approved pack goes as both its files.
    attachments: ctx.pack ? describePackAttachments(await packAttachments(ctx.pack.id)) : [],
  };
}

/**
 * A renewal pack uploaded by hand at this stage — in place of the approved
 * version, so it has to say why. Kept with its reason and audited; the
 * email that carries it names it.
 */
export async function uploadPack(placementId, input, user) {
  const ctx = await contextFor(placementId);
  const reason = String(input.reason || '').trim();
  if (reason.length < 5) throw new ValidationError('Say why a pack is being attached by hand instead of the approved version');
  const content = Buffer.from(String(input.content_base64 || ''), 'base64');
  if (!content.length) throw new ValidationError('Uploaded file is empty or not valid base64');
  if (content.length > 15 * 1024 * 1024) throw new ValidationError('The pack exceeds the 15MB upload limit');
  const { rows } = await query(
    `INSERT INTO final_placement_pack_upload (final_placement_id, filename, mime_type, size_bytes, content, reason, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, filename, mime_type, size_bytes, reason, created_at`,
    [ctx.final.id, input.filename, input.mime_type || 'application/octet-stream', content.length, content, reason, user.id],
  );
  await audit({
    entityType: 'final_placement', entityId: ctx.final.id, action: 'pack_upload', userId: user.id,
    detail: { upload_id: rows[0].id, filename: input.filename, size_bytes: content.length, reason, approved_pack: ctx.pack?.version ?? null },
  });
  return { upload: rows[0], ...(await getFinalPlacement(placementId)) };
}

async function uploadAttachment(finalId, uploadId) {
  const { rows } = await query(
    'SELECT filename, mime_type, content FROM final_placement_pack_upload WHERE id = $1 AND final_placement_id = $2',
    [uploadId, finalId],
  );
  if (!rows[0]) throw new NotFoundError('Uploaded pack');
  return { format: 'upload', filename: rows[0].filename, content: rows[0].content, contentType: rows[0].mime_type };
}

async function resolveRecipients(selections) {
  if (!selections?.length) throw new ValidationError('Choose at least one underwriter to send to');
  const out = [];
  const seen = new Set();
  for (const sel of selections) {
    const { rows: mRows } = await query('SELECT * FROM market WHERE id = $1', [sel.market_id]);
    const market = mRows[0];
    if (!market) throw new NotFoundError('Market');
    if (market.security_status === 'declined') throw new ConflictError(`${market.name} is on the declined-security list`);
    let contact = null;
    if (sel.contact_id) {
      const { rows } = await query('SELECT * FROM market_contact WHERE id = $1 AND market_id = $2', [sel.contact_id, sel.market_id]);
      contact = rows[0];
      if (!contact) throw new NotFoundError('Underwriter contact');
    }
    const email = String(sel.email || contact?.email || '').trim().toLowerCase();
    if (!email) throw new ValidationError(`No underwriter email on file for ${market.name}`);
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ market_id: market.id, market_name: market.name, contact_id: contact?.id || null, name: sel.name || contact?.name || null, email });
  }
  return out;
}

/**
 * Send the firm order terms, a confirmation of signed lines, or the courtesy
 * note to a market that declined, to the chosen underwriters — each message
 * merged for its recipient alone, so no market sees another's line.
 *
 * `input.merge` is a caller-supplied lines block per market, for a
 * confirmation whose lines live on the layer ledger rather than on the final
 * terms (the renewal desk); without it the block is read from the stored
 * final lines. Every recipient is audited on their own, with the outcome.
 */
export async function sendEmail(placementId, input, user) {
  const ctx = await contextFor(placementId);
  const kind = EMAIL_KINDS[input.kind] ? input.kind : 'fot';
  const render = EMAIL_KINDS[kind];
  const recipients = await resolveRecipients(input.recipients);
  const subject = input.subject || render.subject(ctx);
  const body = input.body || render.body({ ...ctx, author: user });
  // The pack rides with the firm order terms: the approved version as its
  // Excel and PDF, or — with the reason it was uploaded — a pack attached by
  // hand. Never both.
  const uploadId = kind === 'fot' ? input.pack_upload_id || null : null;
  const attachPack = kind === 'fot' && !uploadId && input.attach_pack !== false && !!ctx.pack;
  const attachments = attachPack
    ? await packAttachments(ctx.pack.id)
    : uploadId ? [await uploadAttachment(ctx.final.id, uploadId)] : [];
  const attachedFormats = attachments.map((a) => a.format);
  const lines = kind === 'confirmation' ? await listLines(ctx.final.id) : [];

  let delivered = 0;
  const outcomes = [];
  for (const r of recipients) {
    const mine = lines.filter((l) => l.market_id === r.market_id);
    const merged = input.merge?.[r.market_id];
    const result = await sendMail({
      to: r.email, name: r.name, subject,
      body: personaliseFinal(body, {
        contactName: r.name,
        marketName: r.market_name,
        lines: merged ?? (mine.length ? linesBlock(mine, ctx.final.terms || []) : null),
      }),
      attachments,
    });
    if (result.sent) delivered += 1;
    outcomes.push({ ...r, status: result.sent ? 'sent' : 'failed', message_id: result.messageId || null, error: result.error || null });
  }
  if (!delivered) throw new ConflictError('Not one underwriter could be reached — nothing was recorded');

  const { rows } = await query(
    `INSERT INTO final_placement_email (final_placement_id, kind, subject, body, attach_pack, pack_id, recipients, delivered, sent_by,
                                        pack_upload_id, attached_formats)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ctx.final.id, kind, subject, body, attachPack, attachPack ? ctx.pack.id : null, JSON.stringify(outcomes), delivered, user.id,
      uploadId, attachedFormats],
  );
  if (kind === 'fot' && ctx.final.status === 'draft') {
    await query("UPDATE final_placement SET status = 'fot_sent', updated_at = now() WHERE id = $1", [ctx.final.id]);
  }
  await audit({
    entityType: 'final_placement', entityId: ctx.final.id, action: render.action,
    userId: user.id, detail: { recipients: recipients.length, delivered, attach_pack: attachPack, attached: attachedFormats, pack_upload_id: uploadId, email_id: rows[0].id },
  });
  for (const o of outcomes) {
    await audit({
      entityType: 'final_placement', entityId: ctx.final.id, action: `${render.action}_recipient`, userId: user.id,
      detail: { email_id: rows[0].id, market_id: o.market_id, market_name: o.market_name, email: o.email, status: o.status, error: o.error },
    });
  }
  return { email: rows[0], ...(await getFinalPlacement(placementId)) };
}

// ------------------------------------------------------------------ lines ---

/** Re-sign every term line down to the order and keep the result on each line. */
async function resignLines(client, final) {
  const { rows: all } = await client.query('SELECT * FROM final_placement_line WHERE final_placement_id = $1', [final.id]);
  const signing = signingByTerm(all, final.terms || []);
  for (const l of all) {
    await client.query('UPDATE final_placement_line SET signed_pct = $2 WHERE id = $1', [l.id, signing[l.term_key]?.signed[l.id] ?? Number(l.written_pct)]);
  }
}

/**
 * Save the written lines (bulk), signing each term line down to the order.
 * A broker's entry is the broker's: it overrides a line the AI read off an
 * email, and every change — entered, overridden, cleared — is kept with
 * what the line said before.
 */
export async function saveLines(placementId, input, user) {
  const final = await loadFinal(placementId);
  if (!final) throw new ConflictError('Save the final terms on the Final Quote tab first');
  if (final.status === 'confirmed') throw new ConflictError('The shares are confirmed; the lines are frozen');
  const keys = new Set((final.terms || []).map((t) => t.key));
  for (const l of input.lines || []) {
    if (!keys.has(l.term_key)) throw new ValidationError(`Unknown line "${l.term_key}" — lines are written against the final terms`);
  }
  await withTransaction(async (client) => {
    for (const l of input.lines || []) {
      const written = Number(l.written_pct) || 0;
      const { rows: existing } = await client.query(
        'SELECT * FROM final_placement_line WHERE final_placement_id = $1 AND market_id = $2 AND term_key = $3',
        [final.id, l.market_id, l.term_key],
      );
      const before = existing[0] || null;
      if (written <= 0) {
        if (before) {
          await client.query('DELETE FROM final_placement_line WHERE id = $1', [before.id]);
          await recordLineChange(client, { finalId: final.id, marketId: l.market_id, termKey: l.term_key, action: 'cleared', source: 'broker', before: lineState(before), after: null, note: l.notes, userId: user.id });
        }
        continue;
      }
      const { rows: saved } = await client.query(
        `INSERT INTO final_placement_line (final_placement_id, market_id, term_key, written_pct, to_stand, contact_id, notes, updated_by, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'broker')
         ON CONFLICT (final_placement_id, market_id, term_key) DO UPDATE
           SET written_pct = EXCLUDED.written_pct, to_stand = EXCLUDED.to_stand, contact_id = COALESCE(EXCLUDED.contact_id, final_placement_line.contact_id),
               notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now(), source = 'broker'
         RETURNING *`,
        [final.id, l.market_id, l.term_key, written, !!l.to_stand, l.contact_id || null, l.notes || null, user.id],
      );
      const after = lineState(saved[0]);
      const was = lineState(before);
      if (!was || was.written_pct !== after.written_pct || was.to_stand !== after.to_stand || was.source !== 'broker') {
        await recordLineChange(client, {
          finalId: final.id, marketId: l.market_id, termKey: l.term_key,
          action: !was ? 'entered' : was.source === 'ai' ? 'overridden' : 'updated',
          source: 'broker', before: was, after, note: l.notes, userId: user.id,
        });
      }
    }
    await resignLines(client, final);
    await audit({ entityType: 'final_placement', entityId: final.id, action: 'lines', userId: user.id, detail: { lines: (input.lines || []).length } }, client);
  });
  return getFinalPlacement(placementId);
}

/**
 * A broker accepts a line the AI read: it stays at the figure the email gave
 * and stops reading as the AI's.
 */
export async function acceptLine(placementId, { market_id: marketId, term_key: termKey }, user) {
  const final = await loadFinal(placementId);
  if (!final) throw new ConflictError('Save the final terms on the Final Quote tab first');
  if (final.status === 'confirmed') throw new ConflictError('The shares are confirmed; the lines are frozen');
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM final_placement_line WHERE final_placement_id = $1 AND market_id = $2 AND term_key = $3 FOR UPDATE',
      [final.id, marketId, termKey],
    );
    if (!rows[0]) throw new NotFoundError('Line');
    if (rows[0].source !== 'ai') throw new ConflictError('This line is already the broker\'s');
    const { rows: saved } = await client.query(
      "UPDATE final_placement_line SET source = 'broker', updated_by = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [rows[0].id, user.id],
    );
    await recordLineChange(client, { finalId: final.id, marketId, termKey, action: 'accepted', source: 'broker', before: lineState(rows[0]), after: lineState(saved[0]), userId: user.id });
    await audit({ entityType: 'final_placement', entityId: final.id, action: 'line_accept', userId: user.id, detail: { market_id: marketId, term_key: termKey } }, client);
  });
  return getFinalPlacement(placementId);
}

// ------------------------------------------------------- lines from email ---

/** The emails the reader looks at: the replies on file for this placement, plus any pasted in. */
async function candidateEmails(placement, final, pasted = []) {
  const { rows: fot } = await query(
    "SELECT MIN(sent_at) AS first_sent FROM final_placement_email WHERE final_placement_id = $1 AND kind = 'fot'",
    [final.id],
  );
  const since = fot[0]?.first_sent || null;
  const { rows: replies } = await query(
    `SELECT r.id, r.market_id, r.from_email, r.from_name, r.subject, r.body, r.received_at, m.name AS market_name
       FROM negotiation_reply r LEFT JOIN market m ON m.id = r.market_id
      WHERE r.placement_id = $1 AND ($2::timestamptz IS NULL OR r.received_at >= $2::timestamptz)
      ORDER BY r.received_at`,
    [placement.id, since],
  );
  const { rows: contacts } = await query(
    `SELECT c.market_id, lower(c.email) AS email, m.name AS market_name
       FROM market_contact c JOIN market m ON m.id = c.market_id WHERE c.email IS NOT NULL`,
  );
  const marketOfEmail = (email) => contacts.find((c) => c.email === String(email || '').toLowerCase()) || null;
  const out = replies.map((r) => ({ ...r, reply_id: r.id, origin: 'reply' }));
  for (const e of pasted) {
    const match = e.market_id ? null : marketOfEmail(e.from_email);
    out.push({
      reply_id: null, origin: 'pasted',
      market_id: e.market_id || match?.market_id || null,
      market_name: match?.market_name || null,
      from_email: e.from_email, from_name: e.from_name || null, subject: e.subject || null,
      body: e.body, received_at: e.received_at || new Date().toISOString(),
    });
  }
  return out.map((e) => {
    if (e.market_id && !e.market_name) {
      const c = contacts.find((x) => x.market_id === e.market_id);
      return { ...e, market_name: c?.market_name || null };
    }
    return e;
  });
}

/**
 * Read the reinsurers' emails for written and signed lines and enter what
 * they say, marked as the AI's reading. A line a broker has entered or
 * accepted is never touched; a line the AI entered before is updated to the
 * latest email. Every entry is recorded with the email it came from.
 */
export async function readLinesFromEmails(placementId, input, user, clients) {
  const placement = await loadPlacement(placementId);
  const final = await loadFinal(placementId);
  if (!final) throw new ConflictError('Save the final terms on the Final Quote tab first');
  if (final.status === 'confirmed') throw new ConflictError('The shares are confirmed; the lines are frozen');
  const terms = final.terms || [];
  if (!terms.length) throw new ConflictError('There are no final terms to write lines against');
  const emails = await candidateEmails(placement, final, input.emails || []);
  const context = { reference: placement.reference, cedant: placement.cedant_name, class: placement.class, currency: placement.currency, terms };
  const { rows: marketRows } = await query("SELECT id, name FROM market WHERE type = 'reinsurer'");
  const marketByName = (name) => marketRows.find((m) => String(m.name).toLowerCase() === String(name || '').toLowerCase()) || null;

  const outcome = { emails: emails.length, read: 0, entered: 0, updated: 0, skipped: [] };
  const readings = [];
  for (const email of emails) {
    const read = await readLines(email, context, clients);
    readings.push({ email: { from: email.from_email, subject: email.subject, market_name: email.market_name, origin: email.origin, reply_id: email.reply_id }, read });
    if (read.kind === 'other' || !read.lines?.length) { outcome.skipped.push({ from: email.from_email, reason: `nothing about a line (${read.kind})` }); continue; }
    outcome.read += 1;
    const marketId = email.market_id || marketByName(email.market_name)?.id || null;
    if (!marketId) { outcome.skipped.push({ from: email.from_email, reason: 'no reinsurer on the register has this address' }); continue; }

    await withTransaction(async (client) => {
      for (const item of read.lines) {
        // The line it names; when it names none and there is one line, that one.
        const term = terms.find((t) => t.key === item.term_key) || (terms.length === 1 ? terms[0] : null);
        if (!term) { outcome.skipped.push({ from: email.from_email, reason: `could not tell which line "${item.evidence || ''}" applies to` }); continue; }
        const written = item.declined ? 0 : Number(item.written_pct);
        if (!item.declined && !(written > 0)) continue;
        const { rows: existing } = await client.query(
          'SELECT * FROM final_placement_line WHERE final_placement_id = $1 AND market_id = $2 AND term_key = $3 FOR UPDATE',
          [final.id, marketId, term.key],
        );
        const before = existing[0] || null;
        if (before && before.source !== 'ai') { outcome.skipped.push({ from: email.from_email, reason: `${term.label}: the broker's line stands` }); continue; }
        const aiRead = { ...item, kind: read.kind, summary: read.summary, source: read.source, provider: read.provider, model: read.model, read_at: read.read_at, from: email.from_email, subject: email.subject, received_at: email.received_at };
        if (item.declined) {
          if (before) {
            await client.query('DELETE FROM final_placement_line WHERE id = $1', [before.id]);
            await recordLineChange(client, { finalId: final.id, marketId, termKey: term.key, action: 'cleared', source: 'ai', before: lineState(before), after: null, note: `Declined by email: ${item.evidence || read.summary}`, userId: user.id });
            outcome.updated += 1;
          }
          continue;
        }
        const { rows: saved } = await client.query(
          `INSERT INTO final_placement_line (final_placement_id, market_id, term_key, written_pct, to_stand, notes, updated_by, source, ai_reply_id, ai_read)
           VALUES ($1,$2,$3,$4,FALSE,$5,$6,'ai',$7,$8)
           ON CONFLICT (final_placement_id, market_id, term_key) DO UPDATE
             SET written_pct = EXCLUDED.written_pct, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now(),
                 source = 'ai', ai_reply_id = EXCLUDED.ai_reply_id, ai_read = EXCLUDED.ai_read
           RETURNING *`,
          [final.id, marketId, term.key, written, `Read from email: ${item.evidence || read.summary}`.slice(0, 1000), user.id, email.reply_id, JSON.stringify(aiRead)],
        );
        const after = lineState(saved[0]);
        if (!before) outcome.entered += 1;
        else if (lineState(before).written_pct !== after.written_pct) outcome.updated += 1;
        else continue;
        await recordLineChange(client, { finalId: final.id, marketId, termKey: term.key, action: before ? 'ai_updated' : 'ai_entered', source: 'ai', before: lineState(before), after, note: item.evidence || read.summary, userId: user.id });
      }
      await resignLines(client, final);
    });
  }
  await audit({ entityType: 'final_placement', entityId: final.id, action: 'lines_read', userId: user.id, detail: { emails: outcome.emails, read: outcome.read, entered: outcome.entered, updated: outcome.updated, skipped: outcome.skipped.length } });
  return { outcome, readings, ...(await getFinalPlacement(placementId)) };
}

/**
 * Finalise the shares: every line is marked signed at its signed percentage,
 * the placement is confirmed, and each underwriter is sent the confirmation
 * carrying their lines.
 */
export async function confirmShares(placementId, input, user) {
  const final = await loadFinal(placementId);
  if (!final) throw new ConflictError('Save the final terms on the Final Quote tab first');
  if (final.status === 'confirmed') throw new ConflictError('The shares are already confirmed');
  const lines = await listLines(final.id);
  if (!lines.length) throw new ConflictError('Record at least one written line before confirming the shares');

  await withTransaction(async (client) => {
    const signing = signingByTerm(lines, final.terms || []);
    for (const l of lines) {
      await client.query("UPDATE final_placement_line SET status = 'signed', signed_pct = $2, updated_at = now() WHERE id = $1",
        [l.id, signing[l.term_key]?.signed[l.id] ?? l.written_pct]);
    }
    await client.query(
      "UPDATE final_placement SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), updated_at = now() WHERE id = $1",
      [final.id, user.id],
    );
    await audit({ entityType: 'final_placement', entityId: final.id, action: 'confirm', userId: user.id, detail: { lines: lines.length } }, client);
  });

  // The confirmations: to the underwriter each market's lines were written
  // with, else the underwriter the FOT went to, else the market's primary.
  let email = null;
  if (input.send !== false) {
    const markets = [...new Set(lines.map((l) => l.market_id))];
    const { rows: fotRecipients } = await query(
      `SELECT r.* FROM final_placement_email e, jsonb_to_recordset(e.recipients) AS r(market_id uuid, contact_id uuid, name text, email text)
       WHERE e.final_placement_id = $1 AND e.kind = 'fot' ORDER BY e.sent_at DESC`,
      [final.id],
    );
    const recipients = [];
    for (const marketId of markets) {
      const withContact = lines.find((l) => l.market_id === marketId && l.contact_email);
      if (withContact) { recipients.push({ market_id: marketId, contact_id: withContact.contact_id }); continue; }
      const fromFot = fotRecipients.find((r) => r.market_id === marketId);
      if (fromFot) { recipients.push({ market_id: marketId, contact_id: fromFot.contact_id || undefined, email: fromFot.email, name: fromFot.name }); continue; }
      const { rows: primary } = await query(
        'SELECT id FROM market_contact WHERE market_id = $1 AND active ORDER BY is_primary DESC, name LIMIT 1', [marketId],
      );
      if (primary[0]) recipients.push({ market_id: marketId, contact_id: primary[0].id });
    }
    if (recipients.length) {
      const sent = await sendEmail(placementId, { kind: 'confirmation', recipients, subject: input.subject, body: input.body }, user);
      email = sent.email;
    }
  }
  return { email, ...(await getFinalPlacement(placementId)) };
}
