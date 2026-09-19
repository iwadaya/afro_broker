import { TRACKER_STAGES } from '../../components.jsx';

/*
 * The renewal desk's six stages, in order — the spine of the uploaded-pack
 * workspace. Each is a tab: the ordinal and the label are fixed, the
 * sub-label under each is the record's real state in the design's words
 * (stageHints), and a visit with no ?tab= lands on the furthest stage the
 * record supports (furthestStage).
 */
export const STAGES = [
  { value: 'pack', ordinal: '01', label: 'Renewal pack' },
  { value: 'summary', ordinal: '02', label: 'AI summary' },
  { value: 'email', ordinal: '03', label: 'Market email' },
  { value: 'responses', ordinal: '04', label: 'Responses' },
  { value: 'signed', ordinal: '05', label: 'Signed lines' },
  { value: 'claims', ordinal: '06', label: 'Claims' },
];

/** The stage a ?tab= value names, or null for anything else. */
export function stageOf(value) {
  return STAGES.find((s) => s.value === value) || null;
}

/**
 * How far through the market the linked placement is, on the tracker's own
 * scale. INCOMPLETE is the branch off LINES_WRITTEN; an unlinked pack, or a
 * placement on a terminal status, has no position.
 */
function placementRank(placement) {
  if (!placement?.status) return -1;
  const status = placement.status === 'INCOMPLETE' ? 'LINES_WRITTEN' : placement.status;
  return TRACKER_STAGES.indexOf(status);
}

/** Whether the linked placement has reached `status` on the happy path. */
export function placementReached(placement, status) {
  const rank = placementRank(placement);
  return rank >= 0 && rank >= TRACKER_STAGES.indexOf(status);
}

/**
 * Proportional or non-proportional, read from the treaty type the broker
 * named on the pack — the reference list's own names (Quota Share, First
 * Surplus, Risk XL, CAT XL, Stop Loss…). Null when the name says neither.
 */
export function treatyBasis(treatyType) {
  const t = String(treatyType || '').toLowerCase();
  if (/non[- ]?prop|excess|\bxl\b|\bxol\b|stop[- ]?loss|aggregate|\bcat\b/.test(t)) return 'NP';
  if (/quota|surplus|proportional|\bqs\b|fac oblig/.test(t)) return 'P';
  return null;
}

/** What each basis is written as, for the copy that names it. */
export const BASIS_LABEL = { P: 'Proportional', NP: 'Non-proportional' };

/**
 * The sub-label under each tab. Every one is the record's real state: the
 * pack's own status and documents, the broker's sign-off on the draft, the
 * linked placement's position in the market, and the treaty's basis.
 */
export function stageHints({ analysis, analysing }) {
  const docs = analysis.documents?.length || 0;
  const placement = analysis.placement;
  const basis = treatyBasis(analysis.treaty_type);
  return {
    pack: analysing ? 'Analysing'
      : analysis.status === 'failed' ? 'Run failed'
        : docs ? `${docs} uploaded` : 'Intake',
    summary: !analysis.result ? 'Not drafted' : analysis.verified_at ? 'Verified' : 'Unverified',
    email: analysis.submission?.status === 'sent' ? 'Sent'
      : analysis.submission?.status === 'pending_approval' ? 'Awaiting release'
        : analysis.submission?.status === 'draft' ? 'Sent back'
          : placementReached(placement, 'LEAD_MARKETING') ? 'Sent' : 'Draft',
    responses: placementReached(placement, 'SIGNED') ? 'Signed'
      : placementReached(placement, 'LINES_WRITTEN') ? 'Lines written'
        : placementReached(placement, 'LEAD_MARKETING') || analysis.submission?.status === 'sent' ? 'Awaiting'
          : 'Written lines',
    signed: analysis.signed_advice ? 'Confirmed' : placementReached(placement, 'SIGNED') ? 'Released' : 'Release',
    claims: basis ? BASIS_LABEL[basis] : 'P & NP',
  };
}

/**
 * Where a visit with no ?tab= lands: the furthest stage the record's data
 * supports. No documents, or packs the model has not read yet, is the
 * intake; a drafted summary is the summary until a broker has signed it off
 * and linked its placement; then the market email, and the responses once
 * the submission has gone out. A re-run keeps the standing draft in force
 * until the new one lands, so the default does not flick back to the intake
 * while the model is reading.
 */
export function furthestStage(analysis) {
  if (!analysis.result) return 'pack';
  if (!analysis.verified_at || !analysis.placement) return 'summary';
  if (analysis.signed_advice) return 'claims';
  if (placementReached(analysis.placement, 'SIGNED')) return 'signed';
  if (analysis.submission?.status === 'sent') return 'responses';
  return 'email';
}
