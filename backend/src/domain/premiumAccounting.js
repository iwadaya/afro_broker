import { ValidationError } from '../lib/errors.js';
export const roundMoney = n => Math.round((n + Number.EPSILON) * 100) / 100;
export function amount(value, label) {
  if (value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e13) throw new ValidationError(`${label} must be a non-negative number`);
  return Number(value);
}
export function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0,10);
  return String(value || '').slice(0,10);
}
export function validDate(value) {
  const s = dateOnly(value), d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0,10) !== s) throw new ValidationError('Enter a valid due date');
  return s;
}
// Clamp month-end dates rather than rolling 31 January into March.
export function addMonths(value, months) {
  const d = new Date(`${validDate(value)}T00:00:00Z`);
  const end = new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+months+1,0));
  return new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),Math.min(d.getUTCDate(),end.getUTCDate()))).toISOString().slice(0,10);
}
export function adjustmentReady(placement, today = new Date()) {
  const asOf=dateOnly(today);
  return asOf >= addMonths(placement.inception,12) && asOf > dateOnly(placement.expiry);
}
/** Signed shares are never normalised to 100%; only the placed share is billed. */
export function allocateSigned(total, lines) {
  const shares=lines.map(l=>({...l,signed_pct:amount(l.signed_pct,'Signed share')}));
  const sum=shares.reduce((s,l)=>s+l.signed_pct,0);
  if (!shares.length || sum <= 0 || sum > 100.00001) throw new ValidationError('Signed lines must total more than 0% and no more than 100%');
  const target=Math.round(Math.abs(total)*sum);
  const allocations=shares.map(l=>({...l,cents:Math.floor(Math.abs(total)*l.signed_pct),fraction:Math.abs(total)*l.signed_pct%1}));
  let residual=target-allocations.reduce((s,l)=>s+l.cents,0);
  const ranked=allocations.slice().sort((a,b)=>b.fraction-a.fraction || String(a.market_id).localeCompare(String(b.market_id)));
  for(let i=0;i<residual;i++)ranked[i%ranked.length].cents++;
  return allocations.map(({cents,fraction,...l})=>({...l,gross_amount:(total<0?-1:1)*cents/100}));
}
export function calculateLayer(kind, layer, terms, {baseline, today = new Date(), placement} = {}) {
  const minimum=amount(terms.minimum_premium,'Minimum premium');
  const deposit=amount(terms.deposit_premium,'Deposit premium');
  if(deposit<minimum)throw new ValidationError(`${layer.name}: deposit cannot be below the minimum premium`);
  const brokerage=amount(terms.brokerage_pct,'Brokerage %');
  if(brokerage>100)throw new ValidationError('Brokerage cannot exceed 100%');
  let gross=deposit, finalPremium=null, egnpi=null, rate=null, initialEgnpi=null;
  if(kind==='adjustment') {
    if(!adjustmentReady(placement,today))throw new ValidationError('Final adjustment is available after expiry and at least 12 months from inception');
    if(!baseline)throw new ValidationError(`${layer.name}: an issued MDP is required before adjustment`);
    initialEgnpi=terms.initial_egnpi==null||terms.initial_egnpi===''?null:amount(terms.initial_egnpi,'Initial EGNPI');
    egnpi=amount(terms.final_egnpi,'Final EGNPI');rate=amount(terms.rate_pct,'Adjustment rate %');
    if(rate>100)throw new ValidationError('Adjustment rate cannot exceed 100%');
    finalPremium=roundMoney(Math.max(minimum,egnpi*rate/100));
    gross=roundMoney(finalPremium-baseline.deposit_premium);
    if(gross<0 && !terms.return_premium_allowed)gross=0;
  }
  const count=kind==='mdp'?Number(terms.instalments):1;
  const frequency=Number(terms.frequency_months ?? 3);
  if(!Number.isInteger(count)||count<1||count>12||!Number.isInteger(frequency)||frequency<1||frequency>12)throw new ValidationError('Use 1–12 instalments and 1–12 months between instalments');
  const first=validDate(terms.first_due);
  const allocated=allocateSigned(gross,layer.lines);
  const notes=[];
  for(const share of allocated) {
    const cents=Math.round(Math.abs(share.gross_amount)*100), base=Math.floor(cents/count);
    for(let i=0;i<count;i++) {
      const part=(share.gross_amount<0?-1:1)*(base+(i<cents%count?1:0))/100;
      if(!part)continue;
      const fee=roundMoney(part*brokerage/100);
      notes.push({...share,gross_amount:part,brokerage_amount:fee,net_amount:roundMoney(part-fee),instalment_no:i+1,due_date:addMonths(first,i*frequency),kind:part>0?'debit':'credit'});
    }
  }
  // Every signed share, moving or not: its share of the deposit billed and of the
  // final premium, and what the adjustment does to it. The reinsurer table reads
  // this, and at adjustment a share left untouched gets a nil advice from it.
  const depositShares=allocateSigned(deposit,layer.lines), finalShares=finalPremium==null?null:allocateSigned(finalPremium,layer.lines);
  const markets=allocated.map((share,i)=>{const fee=roundMoney(share.gross_amount*brokerage/100);return {market_id:share.market_id,market_name:share.market_name,signed_pct:share.signed_pct,deposit_share:depositShares[i].gross_amount,final_premium_share:finalShares?finalShares[i].gross_amount:null,gross_amount:share.gross_amount,brokerage_amount:fee,net_amount:roundMoney(share.gross_amount-fee),kind:share.gross_amount>0?'debit':share.gross_amount<0?'credit':'none'};});
  return {layer_key:layer.key,name:layer.name,currency:layer.currency,minimum_premium:minimum,deposit_premium:deposit,initial_egnpi:initialEgnpi,markets,rate_pct:rate ?? (terms.rate_pct==null||terms.rate_pct===''?null:amount(terms.rate_pct,'Adjustment rate %')),brokerage_pct:brokerage,return_premium_allowed:!!terms.return_premium_allowed,final_egnpi:egnpi,final_premium:finalPremium,adjustment_100:kind==='adjustment'?gross:null,premium_100:gross,notes};
}
