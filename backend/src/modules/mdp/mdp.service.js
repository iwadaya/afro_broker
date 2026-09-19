import { withTransaction, query } from '../../db/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { buildMdpSchedule } from '../../domain/xol.js';
import { allocatePremium } from '../../domain/signingDown.js';

const round2 = (n) => Math.round(n * 100) / 100;

/** The layer's signed lines, as inputs to per-market allocation. */
async function signedLines(runner, layerId) {
  const { rows } = await runner.query(
    `SELECT l.id, l.market_id, m.name AS market_name, l.signed_pct
     FROM line l JOIN market m ON m.id = l.market_id
     WHERE l.layer_id = $1 AND l.status = 'SIGNED' ORDER BY m.name`,
    [layerId],
  );
  return rows.map((r) => ({ id: r.market_id, market_name: r.market_name, signed: Number(r.signed_pct || 0) }));
}

export async function getMdp(layerId) {
  const { rows: history } = await query(
    'SELECT * FROM mdp WHERE layer_id = $1 ORDER BY version DESC', [layerId],
  );
  const active = history.find((m) => m.status === 'issued') || null;
  let notes = [];
  if (active) {
    ({ rows: notes } = await query(
      `SELECT n.*, m.name AS market_name FROM mdp_debit_note n JOIN market m ON m.id = n.market_id
       WHERE n.mdp_id = $1 ORDER BY n.instalment_no, m.name`,
      [active.id],
    ));
  }
  return { mdp: active, history, notes };
}

/**
 * Issue the MDP for a bound XoL layer: store the terms, spread the deposit
 * premium over the instalment schedule and auto-generate a debit note per
 * market per instalment (the market's signed share, brokerage carved out).
 * A prior issued MDP is superseded; its notes remain as history.
 */
export async function issueMdp(layerId, input, userId) {
  return withTransaction(async (client) => {
    const { rows: layerRows } = await client.query('SELECT * FROM layer WHERE id = $1 FOR UPDATE', [layerId]);
    const layer = layerRows[0];
    if (!layer) throw new NotFoundError('Layer');
    if (layer.type !== 'XoL') throw new ConflictError('MDPs apply to XoL layers');
    if (!['SIGNED', 'BOUND'].includes(layer.status)) {
      throw new ConflictError('Layer must be SIGNED or BOUND to issue an MDP');
    }

    const lines = await signedLines(client, layerId);
    if (lines.length === 0) throw new ConflictError('No signed lines; sign the layer first');

    const { rows: pRows } = await client.query('SELECT * FROM placement WHERE id = $1', [layer.placement_id]);
    const firstDue = input.first_due || pRows[0].inception;
    const instalments = input.instalments ?? 4;
    const frequencyMonths = input.frequency_months ?? 3;

    const schedule = buildMdpSchedule({
      depositPremium: input.deposit_premium,
      instalments,
      firstDue,
      frequencyMonths,
    });

    await client.query(
      "UPDATE mdp SET status = 'superseded' WHERE layer_id = $1 AND status = 'issued'", [layerId],
    );
    const { rows: verRows } = await client.query(
      'SELECT COALESCE(MAX(version),0)+1 AS next FROM mdp WHERE layer_id = $1', [layerId],
    );
    const { rows: mdpRows } = await client.query(
      `INSERT INTO mdp (layer_id, version, minimum_premium, deposit_premium, adjustment_rate_pct,
                        instalments, frequency_months, first_due, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [layerId, verRows[0].next, input.minimum_premium, input.deposit_premium,
        input.adjustment_rate_pct ?? null, instalments, frequencyMonths, firstDue, userId],
    );
    const mdp = mdpRows[0];

    const brokeragePct = Number(layer.brokerage_pct || 0);
    const notes = [];
    for (const inst of schedule) {
      const alloc = allocatePremium(inst.amount, lines);
      for (const a of alloc) {
        const gross = a.premiumSigned;
        const brokerage = round2(gross * (brokeragePct / 100));
        const { rows: noteRows } = await client.query(
          `INSERT INTO mdp_debit_note (mdp_id, layer_id, market_id, instalment_no, due_date,
                                       signed_pct, gross_amount, brokerage_amount, net_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [mdp.id, layerId, a.id, inst.instalment_no, inst.due_date,
            a.signed, gross, brokerage, round2(gross - brokerage)],
        );
        notes.push(noteRows[0]);
      }
    }

    // The generated schedule lands in the document worklist (Wording).
    const { rows: verDoc } = await client.query(
      "SELECT COALESCE(MAX(version),0)+1 AS next FROM document WHERE layer_id = $1 AND type = 'mdp_schedule'",
      [layerId],
    );
    await client.query(
      `INSERT INTO document (placement_id, layer_id, type, version, content, created_by)
       VALUES ($1,$2,'mdp_schedule',$3,$4,$5)`,
      [layer.placement_id, layerId, verDoc[0].next,
        JSON.stringify({
          mdp: {
            version: mdp.version,
            minimum_premium: Number(mdp.minimum_premium),
            deposit_premium: Number(mdp.deposit_premium),
            adjustment_rate_pct: mdp.adjustment_rate_pct != null ? Number(mdp.adjustment_rate_pct) : null,
            instalments, frequency_months: frequencyMonths, first_due: firstDue,
          },
          schedule,
          markets: lines,
        }), userId],
    );

    await audit(
      { entityType: 'mdp', entityId: mdp.id, action: 'issue', userId,
        detail: { version: mdp.version, instalments, notes: notes.length } },
      client,
    );
    return { mdp, schedule, notes };
  });
}

const NOTE_TRANSITIONS = { pending: ['sent'], sent: ['paid'] };

/** Track a debit note out the door and paid: pending → sent → paid. */
export async function setNoteStatus(noteId, status, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM mdp_debit_note WHERE id = $1 FOR UPDATE', [noteId]);
    const note = rows[0];
    if (!note) throw new NotFoundError('Debit note');
    if (!(NOTE_TRANSITIONS[note.status] || []).includes(status)) {
      throw new ConflictError(`Cannot move debit note from ${note.status} to ${status}`);
    }
    const stamp = status === 'sent' ? 'sent_at' : 'paid_at';
    const { rows: upd } = await client.query(
      `UPDATE mdp_debit_note SET status = $1, ${stamp} = now() WHERE id = $2 RETURNING *`,
      [status, noteId],
    );
    await audit({ entityType: 'mdp_debit_note', entityId: noteId, action: status, userId }, client);
    return upd[0];
  });
}
