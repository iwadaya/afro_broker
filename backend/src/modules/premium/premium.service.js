import { query, withTransaction } from '../../db/pool.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { calculateLayer, adjustmentReady, dateOnly } from '../../domain/premiumAccounting.js';
import { loadPremiumSource } from './premium.source.js';
import { renderPremiumNote } from './premium.pdf.js';
import { resolveTransport, sendMail } from '../../integrations/mailer.js';

export function createPremiumService({db={query}, transaction=withTransaction, mail=sendMail, transport=resolveTransport, today=()=>new Date()}={}) {
  const allowedReview=['senior_broker','underwriter','admin'];
  const action=async(client,id,name,user,detail={})=>audit({entityType:'premium_workflow',entityId:id,action:name,userId:user.id,detail},client);
  const find=async(client,id,lock=false)=>{
    const w=(await client.query(`SELECT * FROM premium_workflow WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
    if(!w)throw new NotFoundError('Premium workflow');return w;
  };
  async function detail(id) {
    const w=await find(db,id);
    const notes=(await db.query(`SELECT id,note_number,layer_key,market_id,kind,currency,instalment_no,due_date,gross_amount,brokerage_amount,net_amount,recipient_email,recipient_name,delivery_status,delivery_error,sent_at,paid_at,detail->>'market_name' AS market_name FROM premium_note WHERE workflow_id=$1 ORDER BY note_number`,[id])).rows;
    return {...w,notes};
  }
  async function contracts() {
    const {rows}=await db.query(`SELECT p.id,p.reference,p.inception,p.expiry,p.currency,p.class_of_business,p.class,c.name AS cedant_name,c.domicile AS country,m.region,
      EXISTS(SELECT 1 FROM premium_workflow w WHERE w.placement_id=p.id AND w.status='submitted') AS awaiting_review
      FROM placement p JOIN cedant c ON c.id=p.cedant_id LEFT JOIN market m ON m.id=c.market_id
      WHERE EXISTS(SELECT 1 FROM layer l WHERE l.placement_id=p.id AND l.type='XoL' AND (l.status IN ('SIGNED','BOUND','CLOSED') OR EXISTS(SELECT 1 FROM line li WHERE li.layer_id=l.id AND li.status='SIGNED' AND li.signed_pct>0)))
      OR EXISTS(SELECT 1 FROM final_placement f CROSS JOIN LATERAL jsonb_array_elements(f.terms) t WHERE f.placement_id=p.id AND f.status='confirmed' AND t->>'basis'='NP' AND EXISTS(SELECT 1 FROM final_placement_line fl WHERE fl.final_placement_id=f.id AND fl.term_key=t->>'key' AND fl.status='signed' AND fl.signed_pct>0))
      ORDER BY p.inception DESC,c.name,p.reference`);
    return rows.map(r=>({...r,inception:dateOnly(r.inception),expiry:dateOnly(r.expiry)}));
  }
  async function workspace(id) {
    const source=await loadPremiumSource(db,id);
    const workflows=(await db.query(`SELECT w.*,u.name AS preparer_name,r.name AS reviewer_name FROM premium_workflow w JOIN users u ON u.id=w.created_by LEFT JOIN users r ON r.id=w.reviewer_id WHERE w.placement_id=$1 ORDER BY w.created_at`,[id])).rows;
    const reviewers=(await db.query("SELECT id,name,role FROM users WHERE active AND role=ANY($1::text[]) ORDER BY name,id",[allowedReview])).rows;
    return {...source,workflows,reviewers,adjustment_ready:adjustmentReady(source.placement,today())};
  }
  async function preview(client,id,kind,input) {
    const src=await loadPremiumSource(client,id);
    const unknown=Object.keys(input.layers||{}).filter(k=>!src.layers.some(l=>l.key===k));
    if(unknown.length)throw new ValidationError('The structure changed; reload this contract');
    if(kind==='adjustment'&&!adjustmentReady(src.placement,today()))throw new ConflictError('Adjustment is available after contract expiry and at least 12 months from inception');
    const layers=src.layers.map(l=>{
      const baseline=src.baseline[l.key];
      if(kind==='adjustment'&&baseline?.lines){
        const signature=lines=>JSON.stringify(lines.map(n=>[n.market_id,Number(n.signed_pct)]).sort((a,b)=>a[0].localeCompare(b[0])));
        if(signature(baseline.lines)!==signature(l.lines))throw new ConflictError(`${l.name}: signing changed since the deposit was billed; reconcile the signed accounts before adjusting`);
      }
      const raw=input.layers?.[l.key];if(!raw)throw new ValidationError(`Complete the premium terms for ${l.name}`);
      // A historic deposit cannot be changed by typing over the adjustment input.
      const terms=kind==='adjustment'?{...raw,deposit_premium:baseline?.deposit_premium}:baseline?{...raw,...baseline}:raw;
      const calc=calculateLayer(kind,l,terms,{baseline,today:today(),placement:src.placement});
      const alreadyBilled=kind==='mdp'&&!!baseline;
      if(alreadyBilled)calc.notes=[];
      const recipient=(market_id,market_name)=>{
        const contact=src.contacts.find(c=>c.id===input.contacts?.[market_id]&&c.market_id===market_id);
        if(!contact||!/^\S+@\S+\.\S+$/.test(contact.email||''))throw new ValidationError(`Choose an active email contact for ${market_name}`);
        return {recipient_email:contact.email,recipient_name:contact.name};
      };
      calc.notes=calc.notes.map(note=>({...note,...recipient(note.market_id,note.market_name)}));
      // At adjustment every signed share hears the outcome, so every share needs a recipient.
      if(kind==='adjustment')calc.markets=calc.markets.map(m=>({...m,...recipient(m.market_id,m.market_name)}));
      return {...l,terms:{...terms,minimum_premium:calc.minimum_premium,deposit_premium:calc.deposit_premium,brokerage_pct:calc.brokerage_pct,rate_pct:calc.rate_pct},already_billed:alreadyBilled,calculation:calc};
    });
    return {placement:src.placement,source:src.source,source_hash:src.source_hash,kind,layers};
  }
  async function save(id,kind,input,user) {
    return transaction(async client=>{
      // One draft per kind per treaty. Lock the parent before testing existence.
      await client.query('SELECT id FROM placement WHERE id=$1 FOR UPDATE',[id]);
      const existing=(await client.query('SELECT * FROM premium_workflow WHERE placement_id=$1 AND kind=$2 FOR UPDATE',[id,kind])).rows[0];
      if(existing && (existing.status!=='draft'||existing.created_by!==user.id))throw new ConflictError('Only the preparer can edit a draft; submitted and issued accounts are locked');
      const snapshot=await preview(client,id,kind,input);
      input={...input,layers:Object.fromEntries(snapshot.layers.map(l=>[l.key,{...input.layers[l.key],deposit_premium:l.terms.deposit_premium}]))};
      const w=existing?(await client.query("UPDATE premium_workflow SET input=$2,snapshot=$3,source_hash=$4,updated_at=now() WHERE id=$1 RETURNING *",[existing.id,JSON.stringify(input),JSON.stringify(snapshot),snapshot.source_hash])).rows[0]:(await client.query("INSERT INTO premium_workflow(placement_id,kind,input,snapshot,source_hash,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",[id,kind,JSON.stringify(input),JSON.stringify(snapshot),snapshot.source_hash,user.id])).rows[0];
      await action(client,w.id,'draft_saved',user,{kind});return w;
    });
  }
  async function submit(id,reviewerId,user) {
    return transaction(async client=>{
      const w=await find(client,id,true);
      if(w.created_by!==user.id)throw new ForbiddenError('Only the preparer can approve and submit this account');
      if(w.status!=='draft')throw new ConflictError('This account is already submitted or issued');
      if(reviewerId===user.id)throw new ConflictError('Four-eyes: select a different approver');
      const reviewer=(await client.query('SELECT id FROM users WHERE id=$1 AND active AND role=ANY($2::text[])',[reviewerId,allowedReview])).rows[0];
      if(!reviewer)throw new ValidationError('Choose an active senior broker, underwriter or administrator');
      const snapshot=await preview(client,w.placement_id,w.kind,w.input);
      if(snapshot.source_hash!==w.source_hash)throw new ConflictError('The structure, signing or contacts changed. Recalculate and save before submission');
      const row=(await client.query("UPDATE premium_workflow SET status='submitted',reviewer_id=$2,submitted_at=now(),return_reason=NULL,updated_at=now() WHERE id=$1 RETURNING *",[id,reviewerId])).rows[0];
      await action(client,id,'maker_approved_and_submitted',user,{reviewer_id:reviewerId});return row;
    });
  }
  async function secondReview(client,w,user) {
    if(w.status!=='submitted')throw new ConflictError('Only a submitted account can be reviewed');
    if(w.created_by===user.id)throw new ConflictError('Four-eyes: the preparer cannot approve their own account');
    if(w.reviewer_id!==user.id)throw new ForbiddenError('This account is assigned to another reviewer');
    const active=(await client.query('SELECT id FROM users WHERE id=$1 AND active AND role=ANY($2::text[])',[user.id,allowedReview])).rows[0];
    if(!active)throw new ForbiddenError('An active authorised reviewer is required');
  }
  async function returnDraft(id,reason,user) {
    if(String(reason||'').trim().length<5)throw new ValidationError('Explain what needs to change');
    return transaction(async client=>{
      const w=await find(client,id,true);await secondReview(client,w,user);
      const row=(await client.query("UPDATE premium_workflow SET status='draft',reviewer_id=NULL,submitted_at=NULL,return_reason=$2,updated_at=now() WHERE id=$1 RETURNING *",[id,reason])).rows[0];
      await action(client,id,'returned_for_changes',user,{reason});return row;
    });
  }
  async function approve(id,user) {
    await transaction(async client=>{
      const initial=await find(client,id);
      await client.query('SELECT id FROM placement WHERE id=$1 FOR UPDATE',[initial.placement_id]);
      const w=await find(client,id,true);await secondReview(client,w,user);
      const src=await loadPremiumSource(client,w.placement_id);
      if(src.source_hash!==w.source_hash)throw new ConflictError('The contract, signing or contacts changed. Return the account to its preparer for recalculation');
      if(w.kind==='adjustment'&&!adjustmentReady(src.placement,today()))throw new ConflictError('The contract is not yet eligible for final adjustment');
      const maker=(await client.query('SELECT name FROM users WHERE id=$1',[w.created_by])).rows[0];
      const issue=async(layer,allocation)=>{
        const seq=(await client.query("SELECT nextval('premium_note_number') AS n")).rows[0].n;
        const number=`PIQ-${today().getUTCFullYear()}-${String(seq).padStart(7,'0')}`;
        const note={...allocation,currency:layer.currency,note_number:number,layer_key:layer.key,detail:{...w.snapshot.placement,layer_name:layer.name,market_name:allocation.market_name,signed_pct:allocation.signed_pct,workflow_kind:w.kind,...layer.terms,...layer.calculation,notes:undefined,markets:undefined,prepared_by:maker.name,approved_by:user.name,issued_at:today().toISOString()}};
        const pdf=await renderPremiumNote(note);
        await client.query(`INSERT INTO premium_note(workflow_id,note_number,layer_key,market_id,kind,currency,instalment_no,due_date,gross_amount,brokerage_amount,net_amount,detail,pdf,recipient_email,recipient_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[id,number,layer.key,allocation.market_id,note.kind,layer.currency,note.instalment_no,note.due_date,note.gross_amount,note.brokerage_amount,note.net_amount,JSON.stringify(note.detail),pdf,note.recipient_email,note.recipient_name]);
      };
      let issued=0;
      for(const layer of w.snapshot.layers) {
        for(const allocation of layer.calculation.notes){await issue(layer,allocation);issued++;}
        // A share the adjustment leaves untouched is told so: a nil advice, numbered and emailed like a note.
        if(w.kind==='adjustment')for(const share of (layer.calculation.markets||[]).filter(m=>m.kind==='none')){await issue(layer,{...share,kind:'advice',gross_amount:0,brokerage_amount:0,net_amount:0,instalment_no:1,due_date:dateOnly(layer.terms.first_due)});issued++;}
      }
      await client.query("UPDATE premium_workflow SET status='issued',approved_by=$2,approved_at=now(),updated_at=now() WHERE id=$1",[id,user.id]);
      await action(client,id,'independently_approved_and_issued',user,{notes:issued});
    });
    // Persist approval and numbered PDFs first. Email failures leave the account
    // issued and visible in the delivery queue, rather than rolling it back.
    await deliverQueued(id);
    return detail(id);
  }
  async function deliverQueued(workflowId=null) {
    for(let i=0;i<30;i++) {
      const n=(await db.query(`UPDATE premium_note SET delivery_status='sending',attempted_at=now(),delivery_error=NULL WHERE id=(SELECT n.id FROM premium_note n JOIN premium_workflow w ON w.id=n.workflow_id WHERE n.delivery_status='queued' AND w.status='issued' AND ($1::uuid IS NULL OR n.workflow_id=$1) ORDER BY n.created_at,n.id FOR UPDATE OF n SKIP LOCKED LIMIT 1) RETURNING *`,[workflowId])).rows[0];
      if(!n)break;
      try {
        const settings=await transport();
        if(settings.transport==='stub' && process.env.NODE_ENV!=='test') {
          await db.query("UPDATE premium_note SET delivery_status='failed',delivery_error='Connect a live email transport before sending' WHERE id=$1",[n.id]);continue;
        }
        const money=v=>Number(v).toFixed(2);
        const message=n.kind==='advice'
          ?{subject:`No adjustment premium | ${n.detail.reference} | ${n.detail.layer_name}`,body:`Dear ${n.recipient_name || 'Underwriter'},\n\nThe final premium adjustment for ${n.detail.cedant_name}, treaty ${n.detail.reference}, ${n.detail.layer_name} has been calculated at ${n.currency} ${money(n.detail.final_premium)} at 100% against the deposit already billed of ${n.currency} ${money(n.detail.deposit_premium)}, so no additional or return premium is due on your ${n.detail.signed_pct}% line. The attached advice ${n.note_number} records this for your file.\n\nKind regards,\nThe broking team`}
          :{subject:`${n.kind==='credit'?'Credit':'Debit'} note ${n.note_number} | ${n.detail.reference} | ${n.detail.layer_name}`,body:`Dear ${n.recipient_name || 'Underwriter'},\n\nPlease find attached ${n.kind} note ${n.note_number} for ${n.detail.cedant_name}, treaty ${n.detail.reference}, ${n.detail.layer_name}.\n\nCurrency: ${n.currency}\nGross premium: ${money(Math.abs(Number(n.gross_amount)))}\nNet premium: ${money(Math.abs(Number(n.net_amount)))}\nDue: ${dateOnly(n.due_date)}\n\nKind regards,\nThe broking team`};
        const result=await mail({to:n.recipient_email,name:n.recipient_name,...message,attachments:[{filename:`${n.note_number}.pdf`,content:Buffer.from(n.pdf),contentType:'application/pdf'}]});
        const state=result.sent?(result.transport==='stub'?'simulated':'sent'):'uncertain';
        await db.query("UPDATE premium_note SET delivery_status=$2,message_id=$3,delivery_error=$4,sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END WHERE id=$1",[n.id,state,result.messageId||null,result.error||null]);
      } catch(error) {
        await db.query("UPDATE premium_note SET delivery_status='uncertain',delivery_error=$2 WHERE id=$1",[n.id,error.message]);
      }
    }
  }
  async function retry(id,user) {
    const w=await find(db,id);
    if(![w.created_by,w.approved_by].includes(user.id))throw new ForbiddenError('Only the preparer or approver may retry delivery');
    await db.query("UPDATE premium_note SET delivery_status='queued' WHERE workflow_id=$1 AND delivery_status='failed'",[id]);
    await action(db,id,'retry_failed_delivery',user);await deliverQueued(id);return detail(id);
  }
  async function settle(noteId,user) {
    return transaction(async client=>{
      const n=(await client.query('SELECT n.*,w.created_by,w.approved_by FROM premium_note n JOIN premium_workflow w ON w.id=n.workflow_id WHERE n.id=$1 FOR UPDATE OF n',[noteId])).rows[0];
      if(!n)throw new NotFoundError('Premium note');
      if(![n.created_by,n.approved_by].includes(user.id))throw new ForbiddenError('Only the preparer or approver can record settlement');
      if(n.kind==='advice')throw new ConflictError('A nil-adjustment advice carries no premium to settle');
      if(!n.paid_at){await client.query('UPDATE premium_note SET paid_at=now() WHERE id=$1',[noteId]);await action(client,n.workflow_id,'settlement_recorded',user,{note_id:noteId});}
      return {settled:true};
    });
  }
  async function reconcile(noteId,input,user) {
    if(String(input.reason||'').trim().length<10)throw new ValidationError('Record the evidence checked before reconciling delivery');
    const workflowId=await transaction(async client=>{
      const n=(await client.query('SELECT n.*,w.approved_by FROM premium_note n JOIN premium_workflow w ON w.id=n.workflow_id WHERE n.id=$1 FOR UPDATE OF n',[noteId])).rows[0];
      if(!n)throw new NotFoundError('Premium note');
      if(n.approved_by!==user.id)throw new ForbiddenError('Only the independent approver may reconcile uncertain delivery');
      if(!['uncertain','sending'].includes(n.delivery_status))throw new ConflictError('This delivery does not require reconciliation');
      if(n.delivery_status==='sending' && Date.now()-new Date(n.attempted_at).getTime()<10*60*1000)throw new ConflictError('Delivery is still in progress; wait before reconciling');
      await client.query("UPDATE premium_note SET delivery_status=$2,delivery_error=NULL,sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END WHERE id=$1",[noteId,input.delivered?'sent':'queued']);
      await action(client,n.workflow_id,'delivery_reconciled',user,{note_id:noteId,...input});return n.workflow_id;
    });
    if(!input.delivered)await deliverQueued(workflowId);return detail(workflowId);
  }
  async function pdf(id) {
    const n=(await db.query('SELECT note_number,pdf FROM premium_note WHERE id=$1',[id])).rows[0];if(!n)throw new NotFoundError('Premium note');return n;
  }
  return {contracts,workspace,detail,preview:(id,kind,input)=>preview(db,id,kind,input),save,submit,approve,returnDraft,retry,settle,reconcile,pdf,deliverQueued};
}
export const premiumService=createPremiumService();
export function startPremiumDeliveryWorker() {
  let busy=false;
  const tick=async()=>{if(busy)return;busy=true;try {await premiumService.deliverQueued();}catch(e){console.error('Premium delivery:',e.message);}finally{busy=false;}};
  const timer=setInterval(tick,30000);timer.unref();void tick();return ()=>clearInterval(timer);
}
