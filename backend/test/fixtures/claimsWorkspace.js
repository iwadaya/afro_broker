import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClaimsWorkspaceService } from '../../src/modules/claims/claimsWorkspace.service.js';
import { servicingSql } from '../../src/modules/dashboards/servicing.routes.js';

export async function verifyClaimsWorkspace(db, transaction) {
  const svc = createClaimsWorkspaceService({ db, transaction });
  const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const user = (name, role) => row("INSERT INTO users(name,email,password_hash,role) VALUES ($1,$2,'test',$3) RETURNING *", [name, `${name}@claims.test`, role]);
  const maker = await user('ClaimsMaker', 'broker'), reviewer = await user('ClaimsReviewer', 'senior_broker'), other = await user('ClaimsOther', 'admin');
  const c = await row("INSERT INTO cedant(name,domicile) VALUES ('Claims test cedant','ZA') RETURNING *");
  const p = await row("INSERT INTO placement(reference,cedant_id,class,inception,expiry,currency) VALUES ('CLAIMS-WORKSPACE',$1,'Property XL','2026-01-01','2026-12-31','USD') RETURNING *", [c.id]);
  const l = await row("INSERT INTO layer(placement_id,name,type,status,currency,attachment,limit_amt,premium100,reinstatements,reinstatement_pct) VALUES ($1,'2m xs 1m','XoL','SIGNED','USD',1000000,2000000,400000,'1',100) RETURNING *", [p.id]);
  const markets = [];
  for (const [name, share] of [['Claims A', 60], ['Claims B', 25]]) {
    const m = await row('INSERT INTO market(name) VALUES ($1) RETURNING *', [name]); markets.push(m);
    await db.query("INSERT INTO line(layer_id,market_id,status,signed_pct) VALUES ($1,$2,'SIGNED',$3)", [l.id, m.id, share]);
  }
  const input = { name: 'Factory fire', reference: 'CL-001', description: '', loss_date: '2026-06-01', retained_loss: 3000000, paid: 2000000, outstanding: 1000000, cat_event: false };
  assert.ok((await svc.contracts()).some(r => r.id === p.id));
  const id = randomUUID();
  await assert.rejects(() => svc.save(id, p.id, { ...input, outstanding: 2 }, 0, maker), /Paid plus outstanding/);
  assert.equal((await row('SELECT COUNT(*)::int AS n FROM loss_event')).n, 0);
  const draft = await svc.save(id, p.id, input, 0, maker);
  assert.equal(draft.snapshot.totals.net, 1600000); assert.equal(draft.snapshot.totals.net_paid, 800000); assert.equal(draft.snapshot.placed_totals.net, 1360000);
  assert.equal((await svc.workspace(p.id)).claims.length, 1);
  await assert.rejects(() => svc.save(id, p.id, input, 0, maker), /updated elsewhere/);
  assert.equal((await row('SELECT COUNT(*)::int AS n FROM loss_event')).n, 1, 'Repeated save does not create a duplicate claim');
  await assert.rejects(() => svc.submit(id, maker.id, maker), /different approver/);
  await svc.submit(id, reviewer.id, maker);
  await assert.rejects(() => svc.approve(id, maker), /authorised|preparer/);
  await assert.rejects(() => svc.approve(id, other), /assigned reviewer/);
  await assert.rejects(() => svc.save(id, p.id, input, 1, maker), /locked/);
  await db.query('UPDATE layer SET premium100=500000 WHERE id=$1', [l.id]);
  assert.equal((await svc.detail(id)).stale, true);
  await assert.rejects(() => svc.approve(id, reviewer), /changed/);
  await svc.returnDraft(id, 'Please check the premium change', reviewer);
  await svc.save(id, p.id, input, 1, maker);
  await svc.submit(id, reviewer.id, maker); await svc.approve(id, reviewer);
  assert.equal((await svc.detail(id)).status, 'approved');
  assert.equal((await row('SELECT settlement FROM loss_event WHERE id=$1', [id])).settlement.ladder.net_due, 1500000);
  await assert.rejects(() => svc.approve(id, reviewer), /submitted claim/);
  const dashboard = (await db.query(servicingSql)).rows.find(r => r.id === p.id);
  assert.equal(dashboard.reported_count, 1); assert.equal(Number(dashboard.reported_amount), 3000000);
  const laterId = randomUUID(), later = { ...input, loss_date: '2026-07-01', reference: 'CL-002' };
  const second = await svc.save(laterId, p.id, later, 0, maker);
  assert.equal(second.snapshot.totals.reinstatement_premium, 0); assert.equal(second.snapshot.layers[0].calculation.remaining_aggregate, 0);
  await assert.rejects(() => svc.save(randomUUID(), p.id, { ...input, loss_date: '2026-05-01' }, 0, maker), /later claim is already approved/);
  // A legacy entry changes the aggregate source and invalidates saved drafts.
  await db.query("INSERT INTO loss_event(placement_id,name,loss_date,gross_loss) VALUES ($1,'Earlier legacy claim','2026-06-15',2000000)", [p.id]);
  assert.equal((await svc.detail(laterId)).stale, true);
  await assert.rejects(() => svc.submit(laterId, reviewer.id, maker), /earlier claims changed/);
  // Confirmed final placements use their signed terms without ledger layers.
  const fp = await row("INSERT INTO placement(reference,cedant_id,class,inception,expiry,currency,quote_structures) VALUES ('CLAIMS-FINAL',$1,'Property XL','2026-01-01','2026-12-31','USD',$2) RETURNING *", [c.id, JSON.stringify([{ layers: [{ reinstatements: '1', reinstatement_pct: 100, aad: 100000, risk_cover: true, cat_cover: false }] }])]);
  const f = await row("INSERT INTO final_placement(placement_id,status,terms) VALUES ($1,'confirmed',$2) RETURNING *", [fp.id, JSON.stringify([{ key: 's1:l0', structure_index: 1, layer_index: 0, label: 'Final XL', basis: 'NP', limit: 2000000, attachment: 1000000, premium: 400000 }])]);
  await db.query("INSERT INTO final_placement_line(final_placement_id,market_id,term_key,status,signed_pct) VALUES ($1,$2,'s1:l0','signed',50)", [f.id, markets[0].id]);
  const final = await svc.save(randomUUID(), fp.id, input, 0, maker);
  assert.equal(final.snapshot.source, 'Confirmed final placement'); assert.equal(final.snapshot.totals.recovery, 1900000); assert.equal(final.snapshot.placed_totals.recovery, 950000);
  await assert.rejects(() => svc.preview(fp.id, { ...input, cat_event: true }), /No placed layer covers/);
  await assert.rejects(() => svc.preview(fp.id, input, id), /another contract/);
  // Paid/reserve development revises one claim and preserves approved history.
  await svc.save(laterId, p.id, later, 1, maker); await svc.submit(laterId, reviewer.id, maker); await svc.approve(laterId, reviewer);
  await assert.rejects(() => svc.reopen(id, other), /Only the preparer/);
  const reopened = await svc.reopen(id, maker);
  const developed = { ...input, paid: 2500000, outstanding: 500000 };
  await svc.save(id, p.id, developed, reopened.revision, maker);
  assert.equal((await svc.detail(laterId)).stale, false, 'Paid/reserve movements do not alter later aggregate use');
  await svc.submit(id, reviewer.id, maker); await svc.approve(id, reviewer);
  const developedDetail = await svc.detail(id); assert.equal(developedDetail.history.length, 2);
  assert.equal(developedDetail.history[1].input.paid, 2000000); assert.equal(developedDetail.input.paid, 2500000);
  assert.equal(developedDetail.snapshot.totals.net_paid, 1125000);
  const nextRevision = await svc.reopen(id, maker);
  await assert.rejects(() => svc.save(id, p.id, { ...developed, retained_loss: 4000000, outstanding: 1500000 }, nextRevision.revision, maker), /later claim is already approved/);
  // Direct database writes cannot break the retained-loss reconciliation.
  await assert.rejects(() => db.query('UPDATE loss_event SET paid=1 WHERE id=$1', [id]), /retained_loss_split/);
  return { svc, placement: p, finalPlacement: fp, input, maker, reviewer, id, laterId };
}
