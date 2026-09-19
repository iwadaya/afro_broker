/*
 * The advices a claim sends to its panel.
 *
 *  - The preliminary loss advice (PLA): a panel-wide reserve advice to every
 *    market with a signed line on any layer of the placement — not only the
 *    layers the loss reaches — with no payment requested. Deduplicated per
 *    market, and idempotent per loss event: loading a notification twice
 *    issues it once.
 *  - The claim advice: the full settlement ladder at 100% of layer, with
 *    each market's own share of every line at its signed percentage merged
 *    in. The reinstatement premium is offset against the claim; there is no
 *    separate reinstatement invoice.
 *
 * Every recipient is audited on its own, with the outcome.
 */

import { query } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { sendMail } from '../../integrations/mailer.js';
import { settlementFor } from '../../domain/claimSettlement.js';

const money = (ccy, v) => `${ccy} ${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v) => `${Number(v || 0).toFixed(4).replace(/\.?0+$/, '')}%`;
const bracket = (ccy, v) => (Number(v) ? `(${money(ccy, v)})` : '—');
const day = (v) => {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
};

async function loadEventFull(id) {
  const { rows } = await query(
    `SELECT e.*, p.reference AS placement_reference, p.currency, p.class, c.name AS cedant_name
       FROM loss_event e JOIN placement p ON p.id = e.placement_id LEFT JOIN cedant c ON c.id = p.cedant_id
      WHERE e.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Loss event');
  const event = rows[0];
  if (event.workspace_claim) throw new ConflictError('This claim uses the retained-loss workspace; review its approved calculation there before preparing an advice');
  const { rows: recoveries } = await query(
    `SELECT r.*, l.name AS layer_name FROM loss_recovery r JOIN layer l ON l.id = r.layer_id
      WHERE r.loss_event_id = $1 ORDER BY l.position`,
    [id],
  );
  return { event, recoveries };
}

/** Every market with a signed line on any layer of the placement, once, with its underwriter. */
export async function panelFor(placementId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (m.id) m.id AS market_id, m.name AS market_name, c.name AS contact_name, c.email,
            (SELECT COUNT(DISTINCT l2.layer_id)::int FROM line l2 JOIN layer ly2 ON ly2.id = l2.layer_id
              WHERE ly2.placement_id = $1 AND l2.market_id = m.id AND COALESCE(l2.signed_pct, 0) > 0) AS layers
       FROM line l
       JOIN layer ly ON ly.id = l.layer_id
       JOIN market m ON m.id = l.market_id
       LEFT JOIN market_contact c ON c.market_id = m.id AND c.active
      WHERE ly.placement_id = $1 AND COALESCE(l.signed_pct, 0) > 0
      ORDER BY m.id, c.is_primary DESC NULLS LAST, c.name`,
    [placementId],
  );
  return rows.sort((a, b) => a.market_name.localeCompare(b.market_name));
}

const personalise = (body, { contactName, marketName, schedule }) => String(body)
  .replaceAll('{{contact_name}}', contactName || 'Underwriter')
  .replaceAll('{{market_name}}', marketName || 'your company')
  .replaceAll('{{schedule}}', schedule || '  (no share on the layers reached)');

/** The preliminary loss advice, reserve only. */
export function renderPla({ event, ladder, author }) {
  const ccy = event.currency;
  const ref = event.reference || event.name;
  return {
    subject: `PRELIMINARY LOSS ADVICE — ${event.placement_reference} — ${ref}${event.insured ? ` — ${event.insured}` : ''}`,
    body: [
      'Dear {{contact_name}},',
      '',
      `We advise a loss under the ${event.cedant_name ? `${event.cedant_name} ` : ''}${event.class} programme, reference ${event.placement_reference}, as follows:`,
      '',
      `  Claim reference    ${ref}`,
      `  Insured            ${event.insured || event.name}`,
      `  Cause              ${event.cause || '—'}`,
      `  Date of loss       ${day(event.loss_date)}`,
      `  Attaching layer    ${ladder.attaching_layer?.name || 'below the programme at the reserve advised'}`,
      `  Reserve advised    ${money(ccy, event.gross_loss)} (100%)`,
      '',
      'This is a preliminary advice for your records, issued to the whole signed panel of the programme. '
      + 'No payment is requested at this stage; a claim advice with your share will follow as the loss develops.',
      '',
      'Kind regards,',
      author?.name || 'The broking team',
      'Universe Broking',
    ].join('\n'),
  };
}

/** One market's share schedule, as the claim advice carries it. */
export function scheduleBlock(share, ccy, ladder) {
  const on = share.lines.filter((l) => l.recovery > 0).map((l) => `${l.layer_name} ${pct(l.signed_pct)}`).join(', ')
    || share.lines.map((l) => `${l.layer_name} ${pct(l.signed_pct)}`).join(', ');
  return [
    `  Signed line                    ${on}`,
    `  Share of gross loss to layer   ${money(ccy, share.gross)}`,
    `  Loss adjustment expenses       ${money(ccy, share.lae)}`,
    `  Salvage and recoveries         ${bracket(ccy, share.salvage)}`,
    `  Reinstatement premium offset   ${ladder.reinstatement_waived ? 'waived' : bracket(ccy, share.reinstatement_premium)}`,
    `  Cash already funded            ${bracket(ccy, share.cash_funded)}`,
    `  Net amount due                 ${money(ccy, share.net_due)}`,
  ].join('\n');
}

/** The claim advice: the 100%-of-layer ladder, with {{schedule}} for each market's share. */
export function renderClaimAdvice({ event, ladder, author }) {
  const ccy = event.currency;
  const ref = event.reference || event.name;
  return {
    subject: `CLAIM ADVICE — ${event.placement_reference} — ${ref}${event.insured ? ` — ${event.insured}` : ''}`,
    body: [
      'Dear {{contact_name}},',
      '',
      `Further to our preliminary advice, we set out the settlement of ${ref}${event.insured ? ` (${event.insured})` : ''}, `
      + `date of loss ${day(event.loss_date)}, under ${event.placement_reference}${ladder.attaching_layer ? `, attaching ${ladder.attaching_layer.name}` : ''}.`,
      '',
      'SETTLEMENT AT 100% OF LAYER',
      `  Gross loss to layer            ${money(ccy, ladder.gross_to_layer)}`,
      `  Add loss adjustment expenses   ${money(ccy, ladder.lae)}`,
      `  Less salvage and recoveries    ${bracket(ccy, ladder.salvage)}`,
      `  Less reinstatement premium     ${ladder.reinstatement_waived ? 'waived' : bracket(ccy, ladder.reinstatement_premium)}`
      + `${ladder.reinstated_pct != null && !ladder.reinstatement_waived ? `  (${ladder.reinstated_pct.toFixed(1)}% of layer reinstated, ${ladder.reinstatement_basis})` : ''}`,
      `  Less cash call already funded  ${bracket(ccy, ladder.cash_funded)}`,
      `  Net amount due from reinsurers ${money(ccy, ladder.net_due)}`,
      '',
      'YOUR SHARE — {{market_name}}',
      '{{schedule}}',
      '',
      'Your share of the above is calculated at your signed line on the layer reached. '
      + 'The reinstatement premium has been offset against the claim; no separate reinstatement invoice will follow.',
      '',
      `Settlement is requested within 30 days. Please quote ${ref} on all correspondence.`,
      '',
      'Kind regards,',
      author?.name || 'The broking team',
      'Universe Broking',
    ].join('\n'),
  };
}

async function recordAdvice({ event, kind, subject, body, breakdown, outcomes, notificationId, user, action }) {
  const delivered = outcomes.filter((o) => o.status === 'sent').length;
  const { rows } = await query(
    `INSERT INTO claim_advice (loss_event_id, kind, subject, body, breakdown, recipients, delivered, notification_id, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [event.id, kind, subject, body, JSON.stringify(breakdown), JSON.stringify(outcomes), delivered, notificationId, user.id],
  );
  await audit({
    entityType: 'loss_event', entityId: event.id, action, userId: user.id,
    detail: { advice_id: rows[0].id, recipients: outcomes.length, delivered, notification_id: notificationId },
  });
  for (const o of outcomes) {
    await audit({
      entityType: 'loss_event', entityId: event.id, action: `${action}_recipient`, userId: user.id,
      detail: { advice_id: rows[0].id, market_id: o.market_id, market_name: o.market_name, email: o.email, status: o.status, error: o.error },
    });
  }
  return rows[0];
}

async function deliver(recipients, { subject, body, personaliseFor }) {
  const outcomes = [];
  for (const r of recipients) {
    if (!r.email) {
      outcomes.push({ ...r, status: 'failed', message_id: null, error: 'No underwriter on file' });
      continue;
    }
    const result = await sendMail({ to: r.email, name: r.contact_name, subject, body: personaliseFor(r) });
    outcomes.push({ ...r, status: result.sent ? 'sent' : 'failed', message_id: result.messageId || null, error: result.error || null });
  }
  return outcomes;
}

/**
 * Issue the preliminary loss advice to the full signed panel. Idempotent:
 * an advice already on the loss event is returned rather than re-sent,
 * unless `resend` says otherwise.
 */
export async function issuePreliminaryAdvice(lossEventId, { notification_id = null, resend = false } = {}, user) {
  const { event, recoveries } = await loadEventFull(lossEventId);
  if (!resend) {
    const { rows } = await query(
      `SELECT * FROM claim_advice WHERE loss_event_id = $1 AND kind = 'preliminary' ORDER BY sent_at DESC LIMIT 1`, [lossEventId],
    );
    if (rows[0]) return { advice: rows[0], already: true };
  }
  const panel = await panelFor(event.placement_id);
  if (!panel.length) throw new ConflictError('No market has a signed line on this placement — there is no panel to advise');
  const { ladder } = settlementFor({ event, recoveries });
  const { subject, body } = renderPla({ event, ladder, author: user });
  const outcomes = await deliver(panel, {
    subject, body, personaliseFor: (r) => personalise(body, { contactName: r.contact_name, marketName: r.market_name }),
  });
  if (!outcomes.some((o) => o.status === 'sent')) throw new ConflictError('Not one market on the panel could be reached — nothing was recorded');
  const advice = await recordAdvice({
    event, kind: 'preliminary', subject, body, breakdown: { reserve: Number(event.gross_loss), ladder },
    outcomes: outcomes.map((o) => ({ market_id: o.market_id, market_name: o.market_name, name: o.contact_name, email: o.email, status: o.status, message_id: o.message_id, error: o.error, layers: o.layers })),
    notificationId: notification_id, user, action: 'preliminary_advice',
  });
  return { advice, already: false };
}

/** The drafted claim advice, for the composer. */
export async function draftClaimAdvice(lossEventId, user) {
  const { event, recoveries } = await loadEventFull(lossEventId);
  const settlement = settlementFor({ event, recoveries });
  return { ...renderClaimAdvice({ event, ladder: settlement.ladder, author: user }), settlement };
}

/**
 * Issue the claim advice: one template, each market's share merged in from
 * its signed line on the layers reached.
 */
export async function issueClaimAdvice(lossEventId, input, user) {
  const { event, recoveries } = await loadEventFull(lossEventId);
  if (!recoveries.length) throw new ConflictError('Calculate the loss before advising it');
  const settlement = settlementFor({ event, recoveries });
  const shares = input.market_ids?.length
    ? settlement.markets.filter((m) => input.market_ids.includes(m.market_id))
    : settlement.markets;
  if (!shares.length) throw new ConflictError('No market has a share of this loss — nothing to advise');
  const { rows: contacts } = await query(
    `SELECT DISTINCT ON (market_id) market_id, name, email FROM market_contact WHERE active AND market_id = ANY($1)
      ORDER BY market_id, is_primary DESC, name`,
    [shares.map((s) => s.market_id)],
  );
  const contactOf = new Map(contacts.map((c) => [c.market_id, c]));
  const draft = renderClaimAdvice({ event, ladder: settlement.ladder, author: user });
  const subject = input.subject || draft.subject;
  const body = input.body || draft.body;
  const recipients = shares.map((s) => ({
    market_id: s.market_id, market_name: s.market_name,
    contact_name: contactOf.get(s.market_id)?.name || null, email: contactOf.get(s.market_id)?.email || null, share: s,
  }));
  const outcomes = await deliver(recipients, {
    subject, body,
    personaliseFor: (r) => personalise(body, { contactName: r.contact_name, marketName: r.market_name, schedule: scheduleBlock(r.share, event.currency, settlement.ladder) }),
  });
  if (!outcomes.some((o) => o.status === 'sent')) throw new ConflictError('Not one market could be reached — nothing was recorded');
  const advice = await recordAdvice({
    event, kind: 'claim', subject, body, breakdown: settlement,
    outcomes: outcomes.map((o) => ({
      market_id: o.market_id, market_name: o.market_name, name: o.contact_name, email: o.email, status: o.status,
      message_id: o.message_id, error: o.error,
      share: { signed_pct: o.share.signed_pct, gross: o.share.gross, lae: o.share.lae, salvage: o.share.salvage, reinstatement_premium: o.share.reinstatement_premium, cash_funded: o.share.cash_funded, net_due: o.share.net_due },
    })),
    notificationId: null, user, action: 'claim_advice',
  });
  return { advice, delivered: advice.delivered, skipped: outcomes.filter((o) => o.status !== 'sent').map((o) => o.market_name) };
}

export async function listAdvices(lossEventId) {
  const { rows } = await query(
    `SELECT a.*, u.name AS sent_by_name FROM claim_advice a LEFT JOIN users u ON u.id = a.sent_by
      WHERE a.loss_event_id = $1 ORDER BY a.sent_at DESC`,
    [lossEventId],
  );
  return rows;
}

