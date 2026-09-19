import { query } from '../../db/pool.js';

/* ── Standard bordereau templates ──────────────────────────────────────
   The canonical column set bordereaux are normalised into. `label` is the
   standard-template header cedants are asked to use; `aliases` seed the
   supervised classifier so it works before any imports have been learned. */

export const TEMPLATES = {
  premium: [
    { field: 'item', label: 'Item', required: false, aliases: ['item', 'no', '#', 'row', 'sr no', 'number'] },
    { field: 'policy_ref', label: 'Policy Reference', required: true, aliases: ['policy reference', 'policy no', 'policy number', 'policy ref', 'certificate no', 'cert ref'] },
    { field: 'insured', label: 'Insured', required: true, aliases: ['insured', 'insured name', 'assured', 'client', 'name of insured'] },
    { field: 'class_of_business', label: 'Class of Business', required: false, aliases: ['class of business', 'class', 'cob', 'line of business', 'lob', 'peril'] },
    { field: 'occupancy', label: 'Occupancy / Risk Description', required: false, aliases: ['occupancy', 'risk description', 'occupation', 'trade', 'business description', 'risk details'] },
    { field: 'territory', label: 'Territory', required: false, aliases: ['territory', 'country', 'location', 'situation', 'region'] },
    { field: 'inception', label: 'Inception', required: false, aliases: ['inception', 'inception date', 'effective date', 'start date', 'from', 'period from'] },
    { field: 'expiry', label: 'Expiry', required: false, aliases: ['expiry', 'expiry date', 'expiration', 'end date', 'to', 'period to'] },
    { field: 'currency', label: 'Ccy', required: false, aliases: ['ccy', 'currency', 'curr', 'original currency'] },
    { field: 'sum_insured_100', label: 'Sum Insured 100%', required: true, aliases: ['sum insured 100%', 'sum insured', 'si', 'tsi', 'total sum insured', 'insured value', 'limit'] },
    { field: 'si_retained', label: 'Cedant SI Retention', required: false, aliases: ['cedant si retention', 'retention', 'retained si', 'net retention', 'cedant retention'] },
    { field: 'si_ceded', label: 'Surplus SI Cession', required: false, aliases: ['surplus si cession', 'cession', 'ceded si', 'si ceded', 'treaty cession', 'surplus cession'] },
    { field: 'si_fac', label: 'SI Facultative', required: false, aliases: ['si facultative', 'fac si', 'facultative', 'fac cession'] },
    { field: 'gross_premium_100', label: 'Gross Premium 100%', required: false, aliases: ['gross premium 100%', 'gross premium', 'gwp', 'premium 100', 'original gross premium', 'total premium'] },
    { field: 'premium_retained', label: 'Premium Retained', required: false, aliases: ['premium retained', 'retained premium', 'net premium'] },
    { field: 'premium_ceded', label: 'Premium Ceded to Surplus', required: true, aliases: ['premium ceded to surplus', 'premium ceded', 'ceded premium', 'treaty premium', 'premium to treaty', 'surplus premium', 'premium'] },
    { field: 'premium_fac', label: 'Premium to Facultative', required: false, aliases: ['premium to facultative', 'fac premium', 'facultative premium'] },
  ],
  claims: [
    { field: 'item', label: 'Item', required: false, aliases: ['item', 'no', '#', 'row', 'sr no', 'number'] },
    { field: 'claim_ref', label: 'Claim Reference', required: true, aliases: ['claim reference', 'claim no', 'claim number', 'claim ref', 'loss ref'] },
    { field: 'policy_ref', label: 'Policy Reference', required: false, aliases: ['policy reference', 'policy no', 'policy number', 'policy ref'] },
    { field: 'insured', label: 'Insured', required: true, aliases: ['insured', 'insured name', 'assured', 'client', 'claimant'] },
    { field: 'class_of_business', label: 'Class of Business', required: false, aliases: ['class of business', 'class', 'cob', 'line of business', 'lob', 'peril'] },
    { field: 'occupancy', label: 'Occupancy / Risk Description', required: false, aliases: ['occupancy', 'risk description', 'occupation', 'trade'] },
    { field: 'territory', label: 'Territory', required: false, aliases: ['territory', 'country', 'location', 'region'] },
    { field: 'date_of_loss', label: 'Date of Loss', required: true, aliases: ['date of loss', 'loss date', 'dol', 'occurrence date', 'accident date'] },
    { field: 'cause_of_loss', label: 'Cause of Loss', required: false, aliases: ['cause of loss', 'cause', 'peril', 'loss description', 'nature of loss'] },
    { field: 'currency', label: 'Ccy', required: false, aliases: ['ccy', 'currency', 'curr'] },
    { field: 'paid', label: 'Paid', required: true, aliases: ['paid', 'paid loss', 'paid amount', 'amount paid', 'settled'] },
    { field: 'outstanding', label: 'Outstanding', required: true, aliases: ['outstanding', 'reserve', 'osr', 'case reserve', 'os reserve', 'outstanding reserve'] },
    { field: 'incurred', label: 'Incurred', required: false, aliases: ['incurred', 'incurred loss', 'total incurred', 'gross incurred'] },
  ],
};


/* ── Combined bordereaux ───────────────────────────────────────────────
   Cedants send premium and claims either as separate files/tabs or as one
   sheet carrying both. A combined sheet maps onto a merged catalogue: the
   columns both templates share are mapped once and copied into each
   bordereau, and the rest are namespaced by the type they belong to. */

/** Fields that mean the same thing in both templates. */
export const SHARED_FIELDS = TEMPLATES.premium
  .filter((p) => TEMPLATES.claims.some((c) => c.field === p.field))
  .map((p) => p.field);

const groupOf = (type, field) => (SHARED_FIELDS.includes(field) ? 'shared' : type);
/** Namespaced id for a field in the combined catalogue, e.g. "claims:paid". */
export const combinedId = (type, field) => `${groupOf(type, field)}:${field}`;
/** Split a combined id back into { group, field }. */
export const splitCombinedId = (id) => {
  const [group, field] = String(id).split(':');
  return field ? { group, field } : { group: null, field: group };
};

/** The merged column catalogue for a combined bordereau. */
export function combinedTemplate() {
  const out = [];
  const seen = new Set();
  for (const [type, cols] of [['premium', TEMPLATES.premium], ['claims', TEMPLATES.claims]]) {
    for (const c of cols) {
      const id = combinedId(type, c.field);
      if (seen.has(id)) continue;
      seen.add(id);
      const group = groupOf(type, c.field);
      out.push({
        field: id,
        label: group === 'shared' ? c.label : `${group === 'premium' ? 'Premium' : 'Claims'} · ${c.label}`,
        // A required column is only required for the half it belongs to; the
        // client checks each half separately, so keep the original flag.
        required: c.required,
        group,
      });
    }
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
const tokens = (s) => {
  const n = norm(s);
  const toks = n.split(' ').filter(Boolean);
  return [...toks, n.replace(/ /g, '')]; // whole header as one token anchors exact matches
};

/* ── Supervised: multinomial naive Bayes over header tokens ────────────
   Training docs are the template aliases (seed knowledge) plus every
   header→field pair a broker has confirmed on a past import. */

export async function loadTrainingSet(type) {
  const docs = [];
  for (const f of TEMPLATES[type]) {
    docs.push({ field: f.field, toks: tokens(f.label) });
    for (const a of f.aliases) docs.push({ field: f.field, toks: tokens(a) });
  }
  const { rows } = await query(
    'SELECT header, field FROM mapping_example WHERE bdx_type = $1', [type],
  );
  for (const r of rows) docs.push({ field: r.field, toks: tokens(r.header), learned: true });
  return docs;
}

export function classifyHeader(header, docs) {
  const hToks = tokens(header);
  const fields = [...new Set(docs.map((d) => d.field))];
  const vocab = new Set(docs.flatMap((d) => d.toks));
  const scores = fields.map((field) => {
    const fieldDocs = docs.filter((d) => d.field === field);
    // Learned examples count double — real confirmations beat seed synonyms.
    const counts = {};
    let total = 0;
    for (const d of fieldDocs) {
      const w = d.learned ? 2 : 1;
      for (const t of d.toks) { counts[t] = (counts[t] || 0) + w; total += w; }
    }
    let logp = Math.log(fieldDocs.length / docs.length);
    for (const t of hToks) {
      logp += Math.log(((counts[t] || 0) + 1) / (total + vocab.size + 1));
    }
    return { field, logp };
  });
  scores.sort((a, b) => b.logp - a.logp);
  // Softmax over log-probs → a usable 0..1 confidence.
  const maxLog = scores[0].logp;
  const expSum = scores.reduce((a, s) => a + Math.exp(s.logp - maxLog), 0);
  return { field: scores[0].field, confidence: Math.exp(0) / expSum };
}

/* ── Unsupervised: content profiling of the column's values ────────────
   No labels involved — columns are typed from their data (dates, currency
   codes, references, magnitudes) and numeric columns are split into
   "sum-insured scale" vs "premium scale" clusters by a 2-means on the log
   of their means, then matched to fields by profile constraints. */

const CCY_CODES = new Set(['USD', 'EUR', 'GBP', 'ZAR', 'KES', 'TZS', 'ZMW', 'NGN', 'MUR', 'BWP', 'AUD', 'CAD', 'CHF', 'JPY', 'CNY', 'INR', 'AED', 'MWK', 'UGX', 'ZWL']);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v);
const asNum = (v) => Number(String(v).replace(/[,\s$£€]/g, ''));

export function profileColumn(values) {
  const vals = values.filter((v) => v !== '' && v != null).map(String);
  if (vals.length === 0) return { kind: 'empty' };
  const frac = (pred) => vals.filter(pred).length / vals.length;
  if (frac(isDate) > 0.8) return { kind: 'date', meanTime: vals.reduce((a, v) => a + (Date.parse(v) || 0), 0) / vals.length };
  if (frac((v) => CCY_CODES.has(v.toUpperCase())) > 0.8) return { kind: 'currency' };
  const numFrac = frac((v) => Number.isFinite(asNum(v)) && String(v).trim() !== '');
  if (numFrac > 0.85) {
    const nums = vals.map(asNum).filter(Number.isFinite);
    const mean = nums.reduce((a, n) => a + n, 0) / (nums.length || 1);
    const distinct = new Set(nums).size;
    const sequential = distinct === nums.length && nums.every((n, i) => i === 0 || n > nums[i - 1]) && Math.abs(nums[0]) < 10;
    return { kind: 'number', mean: Math.abs(mean), distinct, count: nums.length, sequential };
  }
  const distinct = new Set(vals.map((v) => v.toLowerCase())).size;
  const refLike = frac((v) => /\d/.test(v) && /[A-Za-z]/.test(v) && /[/\-#]/.test(v)) > 0.6;
  const avgLen = vals.reduce((a, v) => a + v.length, 0) / vals.length;
  return { kind: 'text', distinct, count: vals.length, refLike, avgLen };
}

/** 2-means on log10(mean) — splits big-money columns (sums insured) from
    small-money columns (premiums) without any labelled data. */
function splitMagnitudes(cols) {
  const pts = cols.map((c) => Math.log10(c.profile.mean + 1));
  if (pts.length < 2) return cols.map(() => 'high');
  let lo = Math.min(...pts); let hi = Math.max(...pts);
  if (hi - lo < 0.5) return cols.map(() => 'high'); // one cluster — all similar scale
  for (let it = 0; it < 12; it += 1) {
    const assign = pts.map((p) => (Math.abs(p - lo) <= Math.abs(p - hi) ? 'low' : 'high'));
    const mean = (side) => {
      const xs = pts.filter((_, i) => assign[i] === side);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : (side === 'low' ? lo : hi);
    };
    const nlo = mean('low'); const nhi = mean('high');
    if (nlo === lo && nhi === hi) break;
    lo = nlo; hi = nhi;
  }
  return pts.map((p) => (Math.abs(p - lo) <= Math.abs(p - hi) ? 'low' : 'high'));
}

export function unsupervisedSuggest(type, headers, samplesByHeader) {
  const profiles = headers.map((h) => ({ header: h, profile: profileColumn(samplesByHeader[h] || []) }));
  const out = {};
  const take = (header, field, confidence) => {
    if (!out[header] && !Object.values(out).some((s) => s.field === field)) {
      out[header] = { field, confidence, method: 'unsupervised' };
    }
  };

  // Dates: order by mean timestamp — premium bdx: inception then expiry.
  const dates = profiles.filter((p) => p.profile.kind === 'date').sort((a, b) => a.profile.meanTime - b.profile.meanTime);
  if (type === 'premium') {
    if (dates[0]) take(dates[0].header, 'inception', 0.6);
    if (dates[1]) take(dates[1].header, 'expiry', 0.6);
  } else if (dates[0]) take(dates[0].header, 'date_of_loss', 0.6);

  for (const p of profiles.filter((x) => x.profile.kind === 'currency')) take(p.header, 'currency', 0.7);

  // Numbers: cluster magnitudes, then assign by rank within each cluster.
  const nums = profiles.filter((p) => p.profile.kind === 'number' && !p.profile.sequential);
  const seq = profiles.find((p) => p.profile.kind === 'number' && p.profile.sequential);
  if (seq) take(seq.header, 'item', 0.55);
  const cluster = splitMagnitudes(nums);
  const high = nums.filter((_, i) => cluster[i] === 'high').sort((a, b) => b.profile.mean - a.profile.mean);
  const low = nums.filter((_, i) => cluster[i] === 'low').sort((a, b) => b.profile.mean - a.profile.mean);
  if (type === 'premium') {
    const siFields = ['sum_insured_100', 'si_ceded', 'si_fac', 'si_retained'];
    const premFields = ['gross_premium_100', 'premium_ceded', 'premium_fac', 'premium_retained'];
    high.forEach((p, i) => siFields[i] && take(p.header, siFields[i], 0.45));
    low.forEach((p, i) => premFields[i] && take(p.header, premFields[i], 0.45));
  } else {
    const lossFields = ['incurred', 'paid', 'outstanding'];
    [...high, ...low].sort((a, b) => b.profile.mean - a.profile.mean)
      .forEach((p, i) => lossFields[i] && take(p.header, lossFields[i], 0.45));
  }

  // Text: reference-like → policy/claim ref; high-cardinality names → insured;
  // low-cardinality short text → class / territory.
  const texts = profiles.filter((p) => p.profile.kind === 'text');
  const refs = texts.filter((p) => p.profile.refLike);
  if (type === 'claims' && refs[0]) take(refs[0].header, 'claim_ref', 0.55);
  const refField = type === 'claims' ? refs[1] : refs[0];
  if (refField) take(refField.header, 'policy_ref', 0.55);
  const names = texts.filter((p) => !p.profile.refLike && p.profile.distinct / p.profile.count > 0.7);
  const longText = names.sort((a, b) => b.profile.avgLen - a.profile.avgLen);
  if (longText[1]) take(longText[1].header, 'insured', 0.4);
  if (longText[0]) take(longText[0].header, type === 'claims' ? 'cause_of_loss' : 'occupancy', 0.4);
  const cats = texts.filter((p) => !p.profile.refLike && p.profile.distinct / p.profile.count <= 0.7)
    .sort((a, b) => a.profile.distinct - b.profile.distinct);
  if (cats[0]) take(cats[0].header, 'territory', 0.35);
  if (cats[1]) take(cats[1].header, 'class_of_business', 0.35);

  return out;
}

/* ── Combined suggestion: supervised first, unsupervised fills gaps ──── */

const SUPERVISED_FLOOR = 0.45;

export async function suggestMappings(type, headers, samplesByHeader) {
  const docs = await loadTrainingSet(type);
  const supervised = headers.map((h) => ({ header: h, ...classifyHeader(h, docs) }));
  const unsup = unsupervisedSuggest(type, headers, samplesByHeader);

  const used = new Set();
  const result = [];
  // Confident supervised picks claim their fields first (best confidence wins ties).
  for (const s of [...supervised].sort((a, b) => b.confidence - a.confidence)) {
    if (s.confidence >= SUPERVISED_FLOOR && !used.has(s.field)) {
      used.add(s.field);
      result.push({ header: s.header, field: s.field, confidence: Math.round(s.confidence * 100) / 100, method: 'supervised' });
    }
  }
  for (const h of headers) {
    if (result.some((r) => r.header === h)) continue;
    const u = unsup[h];
    if (u && !used.has(u.field)) {
      used.add(u.field);
      result.push({ header: h, field: u.field, confidence: u.confidence, method: 'unsupervised' });
    } else {
      result.push({ header: h, field: 'ignore', confidence: 0, method: 'none' });
    }
  }
  // Return in original header order.
  return headers.map((h) => result.find((r) => r.header === h));
}

/* ── Type detection ────────────────────────────────────────────────────
   Which kind of bordereau is this? Marker columns are scored against the
   headers (an exact template/alias hit, or every alias token present in the
   header), with the sheet name as a tiebreak. A sheet that scores on both
   sides is a combined bordereau. */

const MARKERS = {
  premium: [
    ['sum_insured_100', 2], ['premium_ceded', 2], ['gross_premium_100', 1.5],
    ['si_ceded', 1], ['si_retained', 1], ['premium_retained', 1],
    ['inception', 0.5], ['expiry', 0.5],
  ],
  claims: [
    ['claim_ref', 2], ['date_of_loss', 2], ['paid', 1.5], ['outstanding', 1.5],
    ['incurred', 1], ['cause_of_loss', 1],
  ],
};
const NAME_HINTS = {
  premium: /prem|risk|polic|underwrit|expos/i,
  claims: /claim|loss|losses|paid|reserve/i,
};
/** Enough marker weight on both sides to call a sheet combined. */
const DETECT_FLOOR = 0.3;

/** Does any header name this field — by exact alias, or by carrying all of an
    alias's words (so "Premium Ceded to Treaty" still hits premium_ceded)? */
function headerMatchesField(headers, type, field) {
  const spec = TEMPLATES[type].find((f) => f.field === field);
  if (!spec) return false;
  const names = [spec.label, spec.field, ...spec.aliases].map(norm);
  return headers.some((h) => {
    const hn = norm(h);
    const flat = hn.replace(/ /g, '');
    if (names.some((n) => n === hn || n.replace(/ /g, '') === flat)) return true;
    const hToks = new Set(hn.split(' ').filter(Boolean));
    return names.some((n) => {
      const nToks = n.split(' ').filter(Boolean);
      return nToks.length > 0 && nToks.every((t) => hToks.has(t));
    });
  });
}

function markerScore(headers, type) {
  const markers = MARKERS[type];
  const total = markers.reduce((a, [, w]) => a + w, 0);
  const hits = markers.filter(([field]) => headerMatchesField(headers, type, field));
  const score = hits.reduce((a, [, w]) => a + w, 0) / total;
  return { score: Math.round(score * 100) / 100, hits: hits.map(([field]) => field) };
}

/**
 * Detect whether a table is a premium bordereau, a claims bordereau, or one
 * sheet carrying both. Returns 'unknown' when neither side scores — the
 * caller should ask rather than guess.
 */
export function detectType(headers, { name = '' } = {}) {
  const premium = markerScore(headers, 'premium');
  const claims = markerScore(headers, 'claims');
  // The sheet or file name only breaks ties; headers are the real evidence.
  const nudge = (type, s) => (NAME_HINTS[type].test(name) ? Math.min(1, s + 0.1) : s);
  const p = nudge('premium', premium.score);
  const c = nudge('claims', claims.score);

  let type;
  if (p >= DETECT_FLOOR && c >= DETECT_FLOOR) type = 'both';
  else if (p >= DETECT_FLOOR || c >= DETECT_FLOOR) type = p >= c ? 'premium' : 'claims';
  else type = 'unknown';

  const confidence = type === 'both' ? Math.min(p, c) : type === 'unknown' ? Math.max(p, c) : Math.max(p, c);
  return {
    type,
    confidence: Math.round(confidence * 100) / 100,
    scores: { premium: premium.score, claims: claims.score },
    markers: { premium: premium.hits, claims: claims.hits },
  };
}

/**
 * Suggestions for a combined sheet: map it as premium and as claims, then
 * keep whichever call is more confident for each header. Fields both
 * templates share collapse into one "shared" target that feeds both halves.
 */
export async function suggestCombined(headers, samplesByHeader) {
  const [premium, claims] = await Promise.all([
    suggestMappings('premium', headers, samplesByHeader),
    suggestMappings('claims', headers, samplesByHeader),
  ]);
  const byHeader = new Map(headers.map((h) => [h, []]));
  for (const [type, list] of [['premium', premium], ['claims', claims]]) {
    for (const s of list) {
      if (s.field === 'ignore') continue;
      byHeader.get(s.header).push({ ...s, id: combinedId(type, s.field) });
    }
  }
  const used = new Set();
  const chosen = new Map();
  // Highest confidence claims its target first, so the two halves cannot
  // fight over the same column.
  const ranked = [...byHeader.entries()]
    .flatMap(([header, options]) => options.map((o) => ({ header, ...o })))
    .sort((a, b) => b.confidence - a.confidence);
  for (const o of ranked) {
    if (chosen.has(o.header) || used.has(o.id)) continue;
    chosen.set(o.header, o);
    used.add(o.id);
  }
  return headers.map((h) => {
    const o = chosen.get(h);
    return o
      ? { header: h, field: o.id, confidence: o.confidence, method: o.method }
      : { header: h, field: 'ignore', confidence: 0, method: 'none' };
  });
}

/** Standard-template match across the combined catalogue. */
export function standardMatchCombined(headers) {
  const used = new Set();
  return headers.map((h) => {
    const n = norm(h).replace(/ /g, '');
    let hit = null;
    for (const type of ['premium', 'claims']) {
      const f = TEMPLATES[type].find((x) => !used.has(combinedId(type, x.field))
        && [x.label, x.field, ...x.aliases].some((a) => norm(a).replace(/ /g, '') === n));
      if (f) { hit = combinedId(type, f.field); break; }
    }
    if (hit) used.add(hit);
    return { header: h, field: hit || 'ignore', confidence: hit ? 1 : 0, method: 'standard' };
  });
}

/** Record broker-confirmed mappings — the supervised model's training data. */
export async function learnMappings(type, mappings, userId) {
  let learned = 0;
  for (const m of mappings) {
    if (!m.header || !m.field || m.field === 'ignore') continue;
    // A combined import sends namespaced ids; a shared column teaches both.
    const { group, field } = splitCombinedId(m.field);
    const types = type !== 'both' ? [type]
      : group === 'shared' ? ['premium', 'claims']
        : [group];
    for (const t of types) {
      if (!TEMPLATES[t]?.some((f) => f.field === field)) continue;
      const { rowCount } = await query(
        `INSERT INTO mapping_example (bdx_type, header, field, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bdx_type, lower(header), field) DO NOTHING`,
        [t, String(m.header).slice(0, 200), field, userId],
      );
      learned += rowCount;
    }
  }
  return learned;
}

/** Standard-template match: strict — exact (normalised) header↔label/field/
    alias equality only. Anything looser belongs to the ML engine. */
export function standardMatch(type, headers) {
  const used = new Set();
  return headers.map((h) => {
    const n = norm(h).replace(/ /g, '');
    const hit = TEMPLATES[type].find((f) => !used.has(f.field)
      && [f.label, f.field, ...f.aliases].some((x) => norm(x).replace(/ /g, '') === n));
    if (hit) used.add(hit.field);
    return { header: h, field: hit ? hit.field : 'ignore', confidence: hit ? 1 : 0, method: 'standard' };
  });
}
