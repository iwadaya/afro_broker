import assert from 'node:assert/strict';
import { servicingSql } from '../../src/modules/dashboards/servicing.routes.js';

// Shared by the normal PostgreSQL integration gate and the isolated PGlite check.
export async function verifyServicing(db) {
  const insert = async (sql, values = []) => (await db.query(sql, values)).rows[0].id;
  const cedant = await insert("INSERT INTO cedant(name,domicile) VALUES ('Servicing fixture','ZA') RETURNING id");
  const market = await insert("INSERT INTO market(name) VALUES ('Servicing fixture market') RETURNING id");
  const placement = async ref => insert("INSERT INTO placement(reference,cedant_id,class,inception,expiry,currency) VALUES ($1,$2,'Property','2025-01-01','2026-01-01','USD') RETURNING id", [ref, cedant]);
  const p = await placement('SERVICING-PLACED');
  const layer = async (pid, type, status, currency = 'USD') => insert("INSERT INTO layer(placement_id,name,type,status,currency) VALUES ($1,'Layer',$2,$3,$4) RETURNING id", [pid,type,status,currency]);
  const l = await layer(p, 'XoL', 'SIGNED');
  await layer(p, 'XoL', 'BOUND', 'EUR');
  await layer(await placement('SERVICING-DRAFT'), 'XoL', 'OPEN');
  await layer(await placement('SERVICING-PROP'), 'QS', 'SIGNED');
  await layer(await placement('SERVICING-FAC'), 'Fac', 'BOUND');
  const old = await insert("INSERT INTO mdp(layer_id,version,minimum_premium,deposit_premium,first_due,status) VALUES ($1,1,0,900,CURRENT_DATE,'superseded') RETURNING id",[l]);
  const current = await insert("INSERT INTO mdp(layer_id,version,minimum_premium,deposit_premium,first_due) VALUES ($1,2,0,900,CURRENT_DATE) RETURNING id",[l]);
  const note = async (mdp,n,amt,status,offset) => db.query("INSERT INTO mdp_debit_note(mdp_id,layer_id,market_id,instalment_no,due_date,signed_pct,gross_amount,net_amount,status) VALUES ($1,$2,$3,$4,CURRENT_DATE + $5::int,100,$6,$6,$7)",[mdp,l,market,n,offset,amt,status]);
  await note(old,1,9999,'paid',-60);
  await note(current,1,100,'paid',-30);
  await note(current,2,200,'sent',0);
  await note(current,3,300,'pending',-1);
  await note(current,4,400,'sent',1);
  const event = await insert("INSERT INTO loss_event(placement_id,name,loss_date,gross_loss) VALUES ($1,'Loss',CURRENT_DATE,1200) RETURNING id",[p]);
  await db.query("INSERT INTO loss_event(placement_id,name,loss_date,gross_loss,status) VALUES ($1,'Settled loss',CURRENT_DATE,800,'settled')",[p]);
  for (const [reserve, delivered, stamp] of [[700,1,'2026-01-01'],[1000,2,'2026-02-01'],[9999,0,'2026-03-01']]) {
    await db.query("INSERT INTO claim_advice(loss_event_id,kind,subject,body,breakdown,delivered,sent_at) VALUES ($1,'preliminary','PLA','Advice',$2,$3,$4)",[event,JSON.stringify({reserve}),delivered,stamp]);
  }
  const finalOnly = await placement('SERVICING-FINAL');
  const final = await insert("INSERT INTO final_placement(placement_id,status,terms) VALUES ($1,'confirmed',$2) RETURNING id",[finalOnly,JSON.stringify([{key:'s1:0',basis:'NP'}])]);
  await db.query("INSERT INTO final_placement_line(final_placement_id,market_id,term_key,status,signed_pct) VALUES ($1,$2,'s1:0','signed',25)",[final,market]);
  const result = (await db.query(servicingSql)).rows.filter(r=>r.reference.startsWith('SERVICING-'));
  assert.equal(result.length,2,'Only signed NP and confirmed NP treaties are placed');
  const row=result.find(r=>r.id===p);
  assert.equal(Number(row.reported_count),2,'Claims are not multiplied by layers or notes');
  assert.equal(Number(row.reported_amount),2000);
  assert.equal(Number(row.pla_count),1,'PLA resends are deduplicated');
  assert.equal(Number(row.pla_amount),1000,'Latest delivered reserve, excluding failed advice');
  const usd=row.premiums.find(p=>p.currency==='USD');
  assert.equal(Number(usd.paid),100,'Superseded schedule excluded');
  assert.equal(Number(usd.due),500,'Includes due today and overdue, excludes future');
  assert.equal(Number(usd.upcoming),400);
  assert.equal(Number(usd.accounts_due),2);
  const eur=row.premiums.find(p=>p.currency==='EUR');
  assert.equal(Number(eur.paid),0,'Currencies stay separate');
  assert.equal(Number(eur.scheduled_layers),0,'Missing schedules remain visible');
  assert.equal(result.find(r=>r.id===finalOnly).premiums.length,0,'Confirmation does not fabricate premium accounts');
}
