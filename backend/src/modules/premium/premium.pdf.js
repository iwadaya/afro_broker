import PDFDocument from 'pdfkit';
const safe = value => String(value ?? '—').replace(/[^\x20-\x7E\xA0-\xFF]/g,'-');
const money = (ccy,n) => `${ccy} ${Math.abs(Number(n)).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export function renderPremiumNote(note) {
  return new Promise((resolve,reject)=>{
    const d=new PDFDocument({size:'A4',margin:48});const parts=[];
    d.on('data',b=>parts.push(b));d.on('end',()=>resolve(Buffer.concat(parts)));d.on('error',reject);
    const s=note.detail, advice=note.kind==='advice';
    d.rect(0,0,595,128).fill('#103c32');
    d.fillColor('#99dec3').font('Helvetica-Bold').fontSize(11).text('AFRO-ASIAN INSURANCE SERVICES  /  TREATY PREMIUM',48,35);
    d.fillColor('white').fontSize(27).text(advice?'NIL ADJUSTMENT ADVICE':note.kind==='credit'?'CREDIT NOTE':'DEBIT NOTE',48,66);
    d.fontSize(10).text(safe(note.note_number),48,104);
    d.y=154;
    const fact=(label,value)=>{d.fillColor('#61746e').font('Helvetica').fontSize(9).text(label.toUpperCase(),48,d.y);d.moveDown(.35);d.fillColor('#153b30').font('Helvetica-Bold').fontSize(11).text(safe(value),{width:499});d.moveDown(.8);};
    fact('To',`${s.market_name} · ${note.recipient_name || ''}`);
    fact('Cedant / Treaty',`${s.cedant_name} / ${s.reference}`);
    fact('Period / Layer',`${s.inception} to ${s.expiry} / ${s.layer_name}`);
    fact('Account',advice?`Final adjustment premium · No premium movement · As at ${note.due_date}`:`${s.workflow_kind==='mdp'?'Minimum & deposit premium':'Final adjustment premium'} · Instalment ${note.instalment_no} · Due ${note.due_date}`);
    fact('Signed line',`${s.signed_pct}% of 100% layer premium`);
    d.moveDown(.4);
    const row=(label,value,bold=false)=>{const y=d.y;d.rect(48,y-5,499,32).fill(bold?'#e4f3ec':'#f5f8f6');d.fillColor('#153b30').font(bold?'Helvetica-Bold':'Helvetica').fontSize(11).text(label,60,y+5,{width:255});d.text(value,320,y+5,{width:215,align:'right'});d.y=y+37;};
    if(advice){row('Final premium (100%)',money(note.currency,s.final_premium));row('Deposit previously billed (100%)',money(note.currency,s.deposit_premium));row('Adjustment premium on your signed line',money(note.currency,0),true);}
    else {row('Gross premium',money(note.currency,note.gross_amount));
    row(`Brokerage (${s.brokerage_pct}%)`,money(note.currency,note.brokerage_amount));
    row(note.kind==='credit'?'Net return premium':'Net premium to reinsurer',money(note.currency,note.net_amount),true);}
    d.moveDown();d.font('Helvetica').fontSize(9).fillColor('#61746e').text(advice?'This advice records that the final adjustment produces no additional or return premium on your signed line.':note.kind==='credit'?'This note records a return premium, subject to the approved treaty terms.':'This note records the premium allocated to your signed share.',48,d.y,{width:499,align:'left'});
    if(s.workflow_kind==='adjustment')d.moveDown().text(safe(`${s.initial_egnpi!=null?`Initial EGNPI: ${money(note.currency,s.initial_egnpi)}. `:''}Final EGNPI: ${money(note.currency,s.final_egnpi)}. Rate: ${s.rate_pct}%. Minimum: ${money(note.currency,s.minimum_premium)}. Deposit previously billed (100%): ${money(note.currency,s.deposit_premium)}. Final premium (100%): ${money(note.currency,s.final_premium)}.`),{width:499});
    d.fontSize(8).text(safe(`Prepared by ${s.prepared_by}; independently approved by ${s.approved_by}. Issued ${s.issued_at}.`),48,746,{width:499});
    d.end();
  });
}
