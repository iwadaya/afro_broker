import assert from 'node:assert/strict';
import {createPremiumService} from '../../src/modules/premium/premium.service.js';
import {dateOnly} from '../../src/domain/premiumAccounting.js';
import {servicingSql} from '../../src/modules/dashboards/servicing.routes.js';
export async function verifyPremiumWorkspace(db,transaction){
  const sent=[];
  const service=createPremiumService({db,transaction,today:()=>new Date('2026-09-14T12:00:00Z'),transport:async()=>({transport:'stub'}),mail:async m=>{sent.push(m);return {sent:true,transport:'stub',messageId:`test-${sent.length}`};}});
  const row=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
  const user=async(name,role)=>row("INSERT INTO users(name,email,password_hash,role) VALUES ($1,$2,'test',$3) RETURNING *",[name,`${name}@premium.test`,role]);
  const maker=await user('PremiumMaker','broker'),reviewer=await user('PremiumReviewer','senior_broker'),other=await user('OtherReviewer','admin');
  const cedant=await row("INSERT INTO cedant(name,domicile) VALUES ('PremiumTestCedant','ZA') RETURNING *");
  const p=await row("INSERT INTO placement(reference,cedant_id,class,inception,expiry,currency) VALUES ('PREMIUM-WORKSPACE',$1,'Property XL','2024-01-01','2024-12-31','USD') RETURNING *",[cedant.id]);
  const markets=[];
  for(const name of ['PremiumMarketA','PremiumMarketB']){const m=await row('INSERT INTO market(name) VALUES ($1) RETURNING *',[name]);m.contact=await row("INSERT INTO market_contact(market_id,name,email,is_primary) VALUES ($1,$2,$3,true) RETURNING *",[m.id,name,`${name}@premium.test`]);markets.push(m);}
  const layers=[];
  for(const ccy of ['USD','EUR','GBP']){const l=await row("INSERT INTO layer(placement_id,name,type,status,currency,premium100,limit_amt,attachment,reinstatements,reinstatement_pct,rate_pct,brokerage_pct,aad) VALUES ($1,$2,'XoL','SIGNED',$3,100.01,10000,1000,'1',100,10,10,500) RETURNING *",[p.id,ccy+' layer',ccy]);layers.push(l);for(let i=0;i<2;i++)await db.query("INSERT INTO line(layer_id,market_id,status,signed_pct) VALUES ($1,$2,'SIGNED',$3)",[l.id,markets[i].id,i?25:60]);}
  const source=await service.workspace(p.id);assert.equal(source.layers.length,3);assert.equal(source.adjustment_ready,true);
  // The structure's aggregates ride beside the layers, outside the hashed source: changing an AAD never stales an account.
  assert.equal(Number(source.aggregates[`layer:${layers[0].id}`].aad),500);assert.equal(source.aggregates[`layer:${layers[0].id}`].agg_limit,null);
  await db.query('UPDATE layer SET aad=750 WHERE id=$1',[layers[0].id]);
  const reread=await service.workspace(p.id);assert.equal(reread.source_hash,source.source_hash,'AAD is display-only');assert.equal(Number(reread.aggregates[`layer:${layers[0].id}`].aad),750);
  const input={layers:Object.fromEntries(source.layers.map(l=>[l.key,{minimum_premium:80,deposit_premium:100.01,rate_pct:10,brokerage_pct:10,return_premium_allowed:true,instalments:2,frequency_months:1,first_due:'2024-01-31'}])),contacts:Object.fromEntries(markets.map(m=>[m.id,m.contact.id]))};
  const draft=await service.save(p.id,'mdp',input,maker);
  assert.equal((await row('SELECT COUNT(*)::int AS n FROM premium_note')).n,0,'Drafts cannot issue notes');
  await assert.rejects(()=>service.submit(draft.id,maker.id,maker),/different approver/);
  await service.submit(draft.id,reviewer.id,maker);
  await assert.rejects(()=>service.approve(draft.id,maker),/preparer cannot approve/);
  await assert.rejects(()=>service.approve(draft.id,other),/another reviewer/);
  await assert.rejects(()=>service.save(p.id,'mdp',input,maker),/locked/);
  await db.query('UPDATE layer SET limit_amt=11000 WHERE id=$1',[layers[0].id]);
  await assert.rejects(()=>service.approve(draft.id,reviewer),/changed/);
  await service.returnDraft(draft.id,'Please verify the amended limit',reviewer);
  await service.save(p.id,'mdp',input,maker);await service.submit(draft.id,reviewer.id,maker);
  const issued=await service.approve(draft.id,reviewer);
  assert.equal(issued.status,'issued');assert.equal(issued.notes.length,12);assert.equal(sent.length,12);
  assert.ok(issued.notes.every(n=>n.delivery_status==='simulated'));
  assert.ok(sent.every(m=>m.attachments[0].content.subarray(0,4).toString()==='%PDF'));
  assert.ok(issued.notes.some(n=>dateOnly(n.due_date)==='2024-02-29'),'Month ends clamp to leap day');
  for(const ccy of ['USD','EUR','GBP'])assert.equal(Math.round(issued.notes.filter(n=>n.currency===ccy).reduce((s,n)=>s+Number(n.gross_amount),0)*100),8501,'85% share is billed, not a normalised 100%');
  await assert.rejects(()=>service.approve(draft.id,reviewer),/Only a submitted/);
  await service.deliverQueued(draft.id);assert.equal(sent.length,12,'No duplicate emails on retry');
  const pdf=await service.pdf(issued.notes[0].id);assert.ok(Buffer.from(pdf.pdf).subarray(0,4).toString()==='%PDF');
  await service.settle(issued.notes[0].id,maker);
  const dash=(await db.query(servicingSql)).rows.find(r=>r.id===p.id);assert.equal(dash.adjustment_due,true);assert.ok(dash.premiums.some(b=>Number(b.paid)>0));
  // USD grows (debit), EUR falls to the minimum (credit), GBP lands exactly on the deposit (nil).
  const adjInput=structuredClone(input);for(let i=0;i<source.layers.length;i++){const t=adjInput.layers[source.layers[i].key],ccy=source.layers[i].currency;t.initial_egnpi=1000;t.final_egnpi=ccy==='USD'?2000:ccy==='EUR'?500:1000.1;t.first_due='2026-09-14';t.deposit_premium=999999;}
  const adj=await service.save(p.id,'adjustment',adjInput,maker);
  assert.equal(adj.snapshot.layers[0].terms.deposit_premium,100.01,'An entered deposit cannot replace the billed deposit');
  assert.equal(adj.snapshot.layers[0].calculation.initial_egnpi,1000);assert.ok(adj.snapshot.layers.every(l=>l.calculation.markets.length===2&&l.calculation.markets.every(m=>m.recipient_email)),'Every share is listed with a recipient');
  assert.deepEqual(adj.snapshot.layers.find(l=>l.currency==='GBP').calculation.markets.map(m=>m.kind),['none','none']);
  await service.submit(adj.id,reviewer.id,maker);const adjusted=await service.approve(adj.id,reviewer);
  assert.equal(adjusted.notes.length,6);assert.equal(adjusted.notes.filter(n=>n.kind==='credit').length,2);
  const advices=adjusted.notes.filter(n=>n.kind==='advice');assert.equal(advices.length,2,'A share with no movement gets a nil advice');
  assert.ok(advices.every(n=>n.currency==='GBP'&&Number(n.gross_amount)===0&&n.delivery_status==='simulated'),'The nil advice is emailed automatically');
  assert.equal(sent.filter(m=>/^No adjustment premium/.test(m.subject)).length,2);assert.equal(sent.length,18);
  assert.ok(Buffer.from((await service.pdf(advices[0].id)).pdf).subarray(0,4).toString()==='%PDF');
  await assert.rejects(()=>service.settle(advices[0].id,maker),/no premium to settle/);
  assert.equal((await db.query(servicingSql)).rows.find(r=>r.id===p.id).adjustment_due,false);
  const noReturn=structuredClone(adjInput);for(const t of Object.values(noReturn.layers)){t.final_egnpi=0;t.return_premium_allowed=false;}
  assert.ok((await service.preview(p.id,'adjustment',noReturn)).layers.every(l=>l.calculation.notes.length===0));
  // Immutable PDF and recipient snapshots survive later register edits.
  await db.query('UPDATE market_contact SET email=$2 WHERE id=$1',[markets[0].contact.id,'changed@premium.test']);
  assert.equal((await service.pdf(issued.notes[0].id)).pdf.length,pdf.pdf.length);
  const missing=structuredClone(input);missing.contacts[markets[0].id]=other.id;
  await assert.rejects(()=>service.preview(p.id,'adjustment',{...adjInput,contacts:missing.contacts}),/active email contact/);
  // A changed signing cannot move a previously billed deposit to another panel.
  await db.query('UPDATE line SET signed_pct=50 WHERE layer_id=$1 AND market_id=$2',[layers[0].id,markets[0].id]);
  await assert.rejects(()=>service.preview(p.id,'adjustment',adjInput),/signing changed/);
  // The confirmed-final-placement path works without a layer-ledger record.
  const finalContract=await row("INSERT INTO placement(reference,cedant_id,class,inception,expiry,currency,quote_structures) VALUES ('PREMIUM-FINAL',$1,'Property XL','2024-01-01','2024-12-31','GBP',$2) RETURNING *",[cedant.id,JSON.stringify([{layers:[{reinstatements:2,reinstatement_pct:100}]}])]);
  const final=await row("INSERT INTO final_placement(placement_id,status,terms) VALUES ($1,'confirmed',$2) RETURNING *",[finalContract.id,JSON.stringify([{key:'s1:l0',structure_index:1,layer_index:0,label:'Final layer',basis:'NP',limit:500000,attachment:100000,premium:2000,rate_pct:2}])]);
  await db.query("INSERT INTO final_placement_line(final_placement_id,market_id,term_key,status,signed_pct) VALUES ($1,$2,'s1:l0','signed',75)",[final.id,markets[0].id]);
  const finalSource=await service.workspace(finalContract.id);assert.equal(finalSource.source,'Confirmed final placement');assert.equal(finalSource.layers[0].reinstatements,2);
  assert.ok((await service.contracts()).some(c=>c.id===finalContract.id));
  const finalInput={layers:{'final:s1:l0':{minimum_premium:1000,deposit_premium:2000,rate_pct:2,brokerage_pct:10,instalments:1,frequency_months:3,first_due:'2024-01-01'}},contacts:input.contacts};
  const finalDraft=await service.save(finalContract.id,'mdp',finalInput,maker);await service.submit(finalDraft.id,reviewer.id,maker);
  let attempts=0;
  const unreliable=createPremiumService({db,transaction,transport:async()=>({transport:'smtp'}),mail:async()=>{attempts++;throw new Error('Connection ended after submission');}});
  const finalIssued=await unreliable.approve(finalDraft.id,reviewer);assert.equal(finalIssued.notes.length,1);assert.equal(Number(finalIssued.notes[0].gross_amount),1500);assert.equal(finalIssued.notes[0].delivery_status,'uncertain');
  await unreliable.retry(finalDraft.id,maker);assert.equal(attempts,1,'Uncertain sends are never retried automatically');
  await assert.rejects(()=>unreliable.reconcile(finalIssued.notes[0].id,{delivered:true,reason:'Checked sender sent items'},maker),/independent approver/);
  await unreliable.reconcile(finalIssued.notes[0].id,{delivered:true,reason:'Confirmed in sender sent items'},reviewer);assert.equal((await service.detail(finalDraft.id)).notes[0].delivery_status,'sent');
  await assert.rejects(()=>service.settle(finalIssued.notes[0].id,other),/preparer or approver/);
  return {service,issued,adjusted,sent,maker,reviewer,pdf};
}
