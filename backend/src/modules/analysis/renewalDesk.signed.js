/*
 * The renewal desk's signed lines: the release confirmed, and one signing
 * advice merged per reinsurer — every market's own layer / written / signed /
 * premium rows, and nothing of anyone else's. It is sent through the final
 * placement module, so the advice is on the placement's record, the
 * confirmations are the module's, and every recipient is audited on their
 * own. Declinatures are not in it; they get the module's courtesy note.
 */

import { query } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { resolveTransport } from '../../integrations/mailer.js';
import * as final from '../final/final.service.js';
import { renderDeclinatureSubject, renderDeclinatureEmail } from '../final/final.email.js';
import { responsesContext } from './renewalDesk.responses.js';
import { renewalYear } from './renewalDesk.email.js';

const clean = (v) => String(v ?? '').trim();
const fmtPct = (v) => `${Number(v || 0).toFixed(2)}%`;
const money = (ccy, v) => `${ccy} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function compact(v) {
  const n = Number(v);
  if (!n) return '0';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 2)}bn`;
  if (Math.abs(n) >= 1e6) {
    const m = n / 1e6;
    return `${m.toLocaleString('en-US', { maximumFractionDigits: m >= 100 ? 0 : 1 })}m`;
  }
  return n.toLocaleString('en-US');
}

/** 'USD 5m xs 5m' — how a layer is named in the advice. */
export const coverOf = (l) => (l.limit_amt != null ? `${l.currency} ${compact(l.limit_amt)} xs ${compact(l.attachment)}` : l.name);

/** One market's merge block: its own rows, as the advice carries them. */
export function mergeBlock(lines, ccy) {
  return lines.map((l) => {
    const label = l.cover && l.cover !== l.layer_name ? `${l.layer_name} — ${l.cover}` : l.layer_name;
    return `  ${label}: written ${fmtPct(l.written_pct)}, signed ${fmtPct(l.signed_pct)}, signed premium ${
      l.premium_signed != null ? money(ccy, l.premium_signed) : '—'}`;
  }).join('\n');
}

const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The signing-down treatment, in the advice's words, from the layers as they
 * were signed: which were oversubscribed and signed down pro rata, which are
 * signed as written — and the rule that holds for all of them.
 */
export function treatmentSentence(layers) {
  const down = layers.filter((l) => l.oversubscribed && l.has_lines);
  const asWritten = layers.filter((l) => !l.oversubscribed && l.has_lines);
  const parts = [];
  if (down.length) {
    parts.push(`${list(down.map((l) => l.name))} ${down.length === 1 ? 'was' : 'were'} oversubscribed and ${
      down.length === 1 ? 'has' : 'have'} been signed down pro rata to the order`);
  }
  if (asWritten.length) {
    parts.push(`${list(asWritten.map((l) => l.name))} ${asWritten.length === 1 ? 'is' : 'are'} signed as written`);
  }
  return `${parts.length ? `${parts.join('; ')}. ` : ''}No line has been signed above the amount written.`;
}

export function adviceSubject({ analysis, placement }) {
  const treaty = clean(analysis.result?.programme?.treaty_name).replace(/\s*[—–-]\s*20\d\d\s*$/, '') || analysis.treaty_type;
  return `SIGNED LINES — ${analysis.cedant_name} ${treaty} ${renewalYear({ placement, analysis })} — Final Signing Advice`;
}

/** The standard advice: one text for the whole market, {{lines}} merged per reinsurer at send. */
export function renderAdvice({ analysis, placement, layers, author }) {
  const treaty = clean(analysis.result?.programme?.treaty_name).replace(/\s*[—–-]\s*20\d\d\s*$/, '') || analysis.treaty_type;
  return [
    'Dear {{contact_name}},',
    '',
    `The ${renewalYear({ placement, analysis })} ${analysis.cedant_name} ${treaty} programme is now complete. `
    + 'The final signed lines of {{market_name}} are confirmed in the schedule below.',
    '',
    '{{lines}}',
    '',
    treatmentSentence(layers),
    '',
    'Contract documentation will follow. Premium instalments fall due as set out in the firm order terms. '
    + 'Claims advices and cash calls will be issued through this desk.',
    '',
    'We thank you for your continued support of this programme.',
    '',
    author?.name || 'The broking team',
    'Universe Broking',
  ].join('\n');
}

async function loadAnalysis(id) {
  const { rows } = await query('SELECT * FROM renewal_pack_analysis WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Renewal pack analysis');
  return rows[0];
}

async function loadPlacement(id) {
  const { rows } = await query(
    `SELECT p.*, c.name AS cedant_name FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id WHERE p.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Placement');
  return rows[0];
}

/** The advices and courtesy notes already issued on the placement, newest first. */
async function adviceEmails(placementId) {
  const { rows } = await query(
    `SELECT e.id, e.kind, e.sent_at, e.recipients, e.delivered
       FROM final_placement_email e JOIN final_placement f ON f.id = e.final_placement_id
      WHERE f.placement_id = $1 AND e.kind IN ('confirmation', 'declinature')
      ORDER BY e.sent_at DESC`,
    [placementId],
  );
  return rows;
}

/** What one market was last sent of a kind, if anything. */
function latestOutcome(emails, kind, marketId) {
  for (const e of emails) {
    if (e.kind !== kind) continue;
    const o = (e.recipients || []).find((r) => r.market_id === marketId);
    if (o) return { at: e.sent_at, status: o.status, email: o.email, error: o.error || null };
  }
  return null;
}

/** The latest signing advice on a placement, for the tab strip. */
export async function latestSigningAdvice(placementId) {
  if (!placementId) return null;
  const e = (await adviceEmails(placementId)).find((x) => x.kind === 'confirmation');
  return e ? { id: e.id, sent_at: e.sent_at, recipients: (e.recipients || []).length, delivered: e.delivered } : null;
}

/**
 * Everything the signed lines tab shows: the gate (every layer released to
 * its order), the recipients — every reinsurer with a signed line on any
 * layer, with its own rows — the declinatures, the template, and what has
 * already been sent.
 */
export async function signedLinesContext(analysisId, user) {
  const analysis = await loadAnalysis(analysisId);
  const resp = await responsesContext(analysisId);
  const summary = { id: analysis.id, cedant_name: analysis.cedant_name, treaty_type: analysis.treaty_type };
  if (!resp.placement) {
    return { analysis: summary, placement: null, layers: [], recipients: [], declinatures: [], blockers: resp.blockers, ready: false, released: false };
  }
  const placement = await loadPlacement(resp.placement.id);
  const layers = resp.layers.map((l) => ({
    id: l.id,
    name: l.name,
    cover: coverOf(l),
    order_pct: l.order_pct,
    written_total: l.written_total,
    signed_total: l.signed_total,
    signed_to_order: l.signed_to_order,
    has_lines: l.rows.some((r) => (r.signed_pct || 0) > 0),
    oversubscribed: l.written_total > l.order_pct,
  }));
  const released = layers.length > 0 && layers.every((l) => l.signed_to_order);
  const blockers = [...resp.blockers];
  if (resp.ready && !released) {
    blockers.push('Every layer must sign to exactly its order — release the signed lines on the Responses tab first');
  }

  const emails = await adviceEmails(placement.id);
  const byMarket = new Map();
  const declined = new Map();
  for (const l of resp.layers) {
    for (const r of l.rows) {
      if ((r.signed_pct || 0) > 0) {
        const m = byMarket.get(r.market_id) || {
          market_id: r.market_id, name: r.market_name, rating: r.rating, underwriter: r.underwriter, email: r.email,
          lines: [], signed_premium: 0,
        };
        m.lines.push({
          layer_id: l.id, layer_name: l.name, cover: coverOf(l),
          written_pct: r.written_pct, signed_pct: r.signed_pct, premium_signed: r.premium_signed,
        });
        m.signed_premium += Number(r.premium_signed || 0);
        byMarket.set(r.market_id, m);
      } else if (r.status === 'declined') {
        const d = declined.get(r.market_id) || {
          market_id: r.market_id, name: r.market_name, underwriter: r.underwriter, email: r.email, layers: [], notes: r.notes || null,
        };
        d.layers.push(l.name);
        declined.set(r.market_id, d);
      }
    }
  }
  const recipients = [...byMarket.values()]
    .map((m) => ({ ...m, layers: m.lines.length, layers_total: layers.length, sent: latestOutcome(emails, 'confirmation', m.market_id) }))
    .sort((a, b) => b.signed_premium - a.signed_premium || a.name.localeCompare(b.name));
  const declinatures = [...declined.values()]
    .filter((d) => !byMarket.has(d.market_id))
    .map((d) => ({ ...d, sent: latestOutcome(emails, 'declinature', d.market_id) }));

  const transport = await resolveTransport();
  const cedant = placement.cedant_name ? { name: placement.cedant_name } : null;
  return {
    analysis: summary,
    placement: {
      id: placement.id, reference: placement.reference, status: placement.status, currency: placement.currency,
      class: placement.class, cedant_name: placement.cedant_name, inception: placement.inception, expiry: placement.expiry,
    },
    layers,
    released,
    ready: blockers.length === 0,
    blockers,
    recipients,
    declinatures,
    treatment: treatmentSentence(layers),
    template: {
      subject: adviceSubject({ analysis, placement }),
      body: renderAdvice({ analysis, placement, layers, author: user }),
    },
    courtesy_template: {
      subject: renderDeclinatureSubject({ placement, cedant }),
      body: renderDeclinatureEmail({ placement, cedant, author: user }),
    },
    advice: await latestSigningAdvice(placement.id),
    mail_transport: transport.transport,
    mail_from: transport.from,
  };
}

/** The final placement record the module keeps its emails on; the desk starts it if the placement has none. */
async function ensureFinal(placementId, user) {
  const current = await final.getFinalPlacement(placementId);
  if (current.final.id) return;
  await final.saveDetails(placementId, { terms: [] }, user);
}

/**
 * Send the signing advice: one template, merged per reinsurer with its own
 * rows, to every market with a signed line — or the ones named. Goes through
 * final.service, which records the email on the placement and audits each
 * recipient with the outcome.
 */
export async function sendSigningAdvices(analysisId, input, user) {
  const ctx = await signedLinesContext(analysisId, user);
  if (!ctx.ready) throw new ConflictError(ctx.blockers.join('; '));
  const wanted = input.market_ids?.length ? ctx.recipients.filter((r) => input.market_ids.includes(r.market_id)) : ctx.recipients;
  if (!wanted.length) throw new ConflictError('No reinsurer has a signed line to confirm');
  const withEmail = wanted.filter((r) => r.email);
  const skipped = wanted.filter((r) => !r.email).map((r) => r.name);
  if (!withEmail.length) throw new ConflictError('No recipient has an underwriter on file — add one on the market register');

  await ensureFinal(ctx.placement.id, user);
  const merge = Object.fromEntries(withEmail.map((r) => [r.market_id, mergeBlock(r.lines, ctx.placement.currency)]));
  const sent = await final.sendEmail(ctx.placement.id, {
    kind: 'confirmation',
    recipients: withEmail.map((r) => ({ market_id: r.market_id, email: r.email, ...(r.underwriter ? { name: r.underwriter } : {}) })),
    subject: input.subject || ctx.template.subject,
    body: input.body || ctx.template.body,
    merge,
  }, user);
  await audit({
    entityType: 'renewal_pack_analysis', entityId: analysisId, action: 'signing_advice', userId: user.id,
    detail: { email_id: sent.email.id, recipients: withEmail.length, delivered: sent.email.delivered, skipped },
  });
  return { email: sent.email, skipped, ...(await signedLinesContext(analysisId, user)) };
}

/** The courtesy note to every market that declined and signed nothing. */
export async function sendDeclinatureNotes(analysisId, input, user) {
  const ctx = await signedLinesContext(analysisId, user);
  if (!ctx.ready) throw new ConflictError(ctx.blockers.join('; '));
  const withEmail = ctx.declinatures.filter((d) => d.email);
  const skipped = ctx.declinatures.filter((d) => !d.email).map((d) => d.name);
  if (!withEmail.length) throw new ConflictError('No declinature has an underwriter on file to write to');

  await ensureFinal(ctx.placement.id, user);
  const sent = await final.sendEmail(ctx.placement.id, {
    kind: 'declinature',
    recipients: withEmail.map((d) => ({ market_id: d.market_id, email: d.email, ...(d.underwriter ? { name: d.underwriter } : {}) })),
    subject: input.subject || ctx.courtesy_template.subject,
    body: input.body || ctx.courtesy_template.body,
  }, user);
  await audit({
    entityType: 'renewal_pack_analysis', entityId: analysisId, action: 'declinature_note', userId: user.id,
    detail: { email_id: sent.email.id, recipients: withEmail.length, delivered: sent.email.delivered, skipped },
  });
  return { email: sent.email, skipped, ...(await signedLinesContext(analysisId, user)) };
}
