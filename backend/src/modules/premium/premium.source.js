import { createHash } from 'node:crypto';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { dateOnly } from '../../domain/premiumAccounting.js';
export async function loadPremiumSource(db,id) {
  const p=(await db.query(`SELECT p.*,c.name AS cedant_name,c.domicile AS country,m.region FROM placement p JOIN cedant c ON c.id=p.cedant_id LEFT JOIN market m ON m.id=c.market_id WHERE p.id=$1`,[id])).rows[0];
  if(!p)throw new NotFoundError('Contract');
  const legacy=(await db.query(`SELECT m.*,l.placement_id FROM mdp m JOIN layer l ON l.id=m.layer_id WHERE l.placement_id=$1 AND l.type='XoL' AND m.status='issued' ORDER BY l.position`,[id])).rows;
  const final=(await db.query("SELECT * FROM final_placement WHERE placement_id=$1 AND status='confirmed'",[id])).rows[0];
  // The structure's aggregate terms — the annual aggregate deductible and, where
  // a structure states one, its aggregate limit — by layer key. Shown beside
  // the layers but entering no premium account, so they sit outside the hashed
  // source: a change to them does not stale an account.
  let source, layers; const aggregates={};
  if(final && !legacy.length && final.terms.some(t=>t.basis==='NP')) {
    source='Confirmed final placement';
    const lines=(await db.query(`SELECT fl.*,m.name AS market_name FROM final_placement_line fl JOIN market m ON m.id=fl.market_id WHERE fl.final_placement_id=$1 AND fl.status='signed' AND fl.signed_pct>0 ORDER BY m.name,fl.id`,[final.id])).rows;
    layers=final.terms.filter(t=>t.basis==='NP').map(t=>{
      const raw=p.quote_structures?.[t.structure_index-1]?.layers?.[t.layer_index]||{};
      aggregates[`final:${t.key}`]={aad:raw.aad??null,agg_limit:raw.agg_limit??null};
      return {key:`final:${t.key}`,name:t.label,currency:p.currency,limit_amt:t.limit,attachment:t.attachment,premium100:t.premium,rate_pct:t.rate_pct,reinstatements:raw.reinstatements??null,reinstatement_pct:raw.reinstatement_pct??raw.reinstatementPct??null,egnpi:raw.egnpi??null,brokerage_pct:raw.brokerage_pct??null,lines:lines.filter(l=>l.term_key===t.key).map(l=>({market_id:l.market_id,market_name:l.market_name,signed_pct:Number(l.signed_pct)}))};
    });
  } else {
    source='Signed layer ledger';
    const rows=(await db.query(`SELECT l.* FROM layer l WHERE l.placement_id=$1 AND l.type='XoL' AND (l.status IN ('SIGNED','BOUND','CLOSED') OR EXISTS (SELECT 1 FROM line li WHERE li.layer_id=l.id AND li.status='SIGNED' AND li.signed_pct>0)) ORDER BY l.position,l.id`,[id])).rows;
    const lines=(await db.query(`SELECT li.*,m.name AS market_name FROM line li JOIN layer l ON l.id=li.layer_id JOIN market m ON m.id=li.market_id WHERE l.placement_id=$1 AND li.status='SIGNED' AND li.signed_pct>0 ORDER BY m.name,li.id`,[id])).rows;
    for(const l of rows)aggregates[`layer:${l.id}`]={aad:l.aad,agg_limit:null};
    layers=rows.map(l=>({key:`layer:${l.id}`,id:l.id,name:l.name,currency:l.currency,limit_amt:l.limit_amt,attachment:l.attachment,premium100:l.premium100,rate_pct:l.rate_pct,reinstatements:l.reinstatements,reinstatement_pct:l.reinstatement_pct,egnpi:l.egnpi,brokerage_pct:l.brokerage_pct,lines:lines.filter(li=>li.layer_id===l.id).map(li=>({market_id:li.market_id,market_name:li.market_name,signed_pct:Number(li.signed_pct)}))}));
  }
  if(!layers.length)throw new ConflictError('This contract has no placed non-proportional structure');
  const marketIds=[...new Set(layers.flatMap(l=>l.lines.map(li=>li.market_id)))];
  const contacts=(await db.query(`SELECT c.id,c.market_id,c.name,c.email,c.is_primary FROM market_contact c WHERE c.market_id=ANY($1::uuid[]) AND c.active ORDER BY c.market_id,c.is_primary DESC,c.name,c.id`,[marketIds])).rows;
  const issuedMdp=(await db.query("SELECT snapshot FROM premium_workflow WHERE placement_id=$1 AND kind='mdp' AND status='issued'",[id])).rows[0]?.snapshot;
  const historicLines=(await db.query(`SELECT DISTINCT n.layer_id,n.market_id,n.signed_pct FROM mdp_debit_note n JOIN mdp m ON m.id=n.mdp_id WHERE m.layer_id=ANY($1::uuid[]) AND m.status='issued' ORDER BY n.market_id`,[layers.map(l=>l.id).filter(Boolean)])).rows;
  const baseline={};
  for(const l of layers) {
    const existing=legacy.find(m=>m.layer_id===l.id);
    if(existing)baseline[l.key]={minimum_premium:Number(existing.minimum_premium),deposit_premium:Number(existing.deposit_premium),rate_pct:existing.adjustment_rate_pct,brokerage_pct:l.brokerage_pct,return_premium_allowed:false,legacy:true,lines:historicLines.filter(n=>n.layer_id===l.id).map(n=>({market_id:n.market_id,signed_pct:Number(n.signed_pct)}))};
    const saved=issuedMdp?.layers.find(x=>x.key===l.key);
    if(saved)baseline[l.key]={...saved.terms,legacy:false,lines:saved.lines.map(n=>({market_id:n.market_id,signed_pct:Number(n.signed_pct)}))};
  }
  const placement={id:p.id,reference:p.reference,cedant_name:p.cedant_name,country:p.country,region:p.region,class_of_business:p.class_of_business||p.class,currency:p.currency,inception:dateOnly(p.inception),expiry:dateOnly(p.expiry)};
  const result={placement,source,layers,contacts,baseline};
  return {...result,aggregates,source_hash:createHash('sha256').update(JSON.stringify(result)).digest('hex')};
}
