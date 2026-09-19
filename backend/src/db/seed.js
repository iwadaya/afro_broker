import bcrypt from 'bcryptjs';
import { pool, query } from './pool.js';
import { up } from './migrate.js';
import { seedWordingLibrary } from './seedWordings.js';
import { seedMarketClauses } from './seedMarketClauses.js';
import { markWordingLibrarySeeded } from './bootstrap.js';
import { seedDemoPacks, seedUnderwriterContacts } from './seedDemoPacks.js';
import { HOUSE } from '../lib/house.js';

/**
 * Seed demo users and — unless SEED_DEMO_BOOK=0 — a demo renewal book: the
 * Grievous Mutual Property CAT XL renewal (GRV-27-PROP-CAT) worked to written
 * lines on layer 2, the surrounding 1 Jan 2027 renewals, a book of filler
 * placements across the pipeline, and bordereaux with a 10-year loss exhibit.
 * The contract-wording library is seeded separately (seedWordings.js).
 *
 * Idempotent: users upsert on email; the book seeds only while GRV-27-PROP-CAT
 * does not exist yet, the demo packs only while DEMO-27-QS does not. Set
 * SEED_RESET=1 to drop the demo book first and rebuild it — the way to recover
 * from a partially-seeded database, and the way a demo deployment starts each
 * deploy clean.
 *
 * The Render blueprint runs this on every deploy (render.yaml's pre-deploy
 * hook, after the migrations), so every step here must stay a no-op on a
 * database it has already seeded.
 */
// One password for every demo user (DEMO_PASSWORD, default demo2026).
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo2026';
const USERS = [
  { email: 'admin@broking.local', name: 'Admin', role: 'admin' },
  { email: 'broker@broking.local', name: 'Demo Broker', role: 'broker' },
  { email: 'senior@broking.local', name: 'Demo Senior Broker', role: 'senior_broker' },
  { email: 'edwin@broking.local', name: 'Edwin', role: 'senior_broker' },
  { email: 'uw@broking.local', name: 'Demo Underwriter', role: 'underwriter' },
  { email: 'a.vance@broking.local', name: 'A. Vance', role: 'broker' },
  { email: 'm.reyes@broking.local', name: 'M. Reyes', role: 'underwriter' },
].map((u) => ({ ...u, password: DEMO_PASSWORD }));

// [name, country of domicile, region]. Region matches the register's
// territory grouping (see MARKETS below) via the cedant's insurer entry.
const CEDANTS = [
  ['Grievous Mutual', 'UK', 'EMEA'],
  ['Nordkap Forsikring', 'Norway', 'EMEA'],
  ['Alzey Versicherung', 'Germany', 'EMEA'],
  ['Helvetia Kantonal', 'Switzerland', 'EMEA'],
  ['Iberia Mutua', 'Spain', 'EMEA'],
  ['Baltica Marine', 'Denmark', 'EMEA'],
  ['Tyrrhenia Assicura', 'Italy', 'EMEA'],
];

// [name, country of domicile, rating, region]. Region groups countries into
// the placement territories the register filters by.
const MARKETS = [
  ['Swiss Re', 'Switzerland', 'AA-', 'EMEA'],
  ['Munich Re', 'Germany', 'AA-', 'EMEA'],
  ['MS Amlin AG', 'Switzerland', 'A+', 'EMEA'],
  ['SCOR SE', 'France', 'A+', 'EMEA'],
  ['Hannover Re', 'Germany', 'AA-', 'EMEA'],
  ['Aspen Bermuda', 'Bermuda', 'A', 'Americas'],
  ['Everest Re', 'Bermuda', 'A+', 'Americas'],
  ['Chubb Re', 'Bermuda', 'AA', 'Americas'],
  ['Fidelis MGU', 'Bermuda', 'A', 'Americas'],
  ['Convex Re', 'Bermuda', 'A', 'Americas'],
  ['Ariel Re 1910', 'Bermuda', 'A', 'Americas'],
  ['Lancashire', 'UK', 'A', 'EMEA'],
];

// The Brokers tab of the register: co-brokers and intermediaries we work
// alongside. They hold no capacity, so they never appear on a panel.
const BROKERS = [
  ['Cornerstone Broking', 'UK', 'EMEA'],
  ['Pinnacle Intermediaries', 'United Arab Emirates', 'EMEA'],
  ['Meridian Partners', 'Singapore', 'Asia Pacific'],
];

// The written panel on GRV-27 layer 2: [market, market ref, written %].
const PANEL = [
  ['Swiss Re', 'SR/26/4412', 15],
  ['Munich Re', 'MR-EMEA-8871', 12.5],
  ['MS Amlin AG', 'MSA/2027/119', 12.5],
  ['SCOR SE', 'SC-27-0043', 10],
  ['Hannover Re', 'HR/PC/27/22', 10],
  ['Aspen Bermuda', 'ASP-27-CAT-08', 10],
  ['Everest Re', 'EV/27/551', 7.5],
  ['Chubb Re', 'CHR-2027-014', 7.5],
  ['Fidelis MGU', 'FID/27/CAT/9', 7.5],
  ['Convex Re', 'CVX-27-0311', 5],
  ['Ariel Re 1910', 'AR1910/27/06', 5],
  ['Lancashire', 'LAN-27-PC-17', 5],
];

// Quote board on GRV-27 layer 2:
// [market, role, type, rol %, line %, status, validity, subjectivities[]]
const QUOTES = [
  ['Swiss Re', 'lead', 'firm', 15.25, 15, 'accepted', '2026-09-30', []],
  ['Munich Re', 'lead', 'firm', 15.10, 12.5, 'accepted', '2026-09-30', []],
  ['SCOR SE', 'follow', 'firm', 15.25, 10, 'active', '2026-09-15', ['Signed 2026 SI banding extract to follow']],
  ['MS Amlin AG', 'follow', 'firm', 15.40, 12.5, 'active', '2026-09-15', []],
  ['Everest Re', 'follow', 'indicative', 16.80, 7.5, 'active', '2026-07-31',
    ['Universe cat model output for the 2027 period', 'Claims bordereau as-at 30 Sep 2026']],
  ['Convex Re', 'follow', 'firm', 15.25, 5, 'active', '2026-09-15', []],
];

// 10-year loss exhibit, USD (design shows 000s): [uy, premium, paid, os, incurred].
const YEARS = [
  [2017, 148200, 71400, 0, 71400],
  [2018, 156800, 132900, 1200, 134100],
  [2019, 163400, 58700, 900, 59600],
  [2020, 171900, 149200, 3400, 152600],
  [2021, 182600, 96800, 6100, 102900],
  [2022, 194300, 211400, 12800, 224200],
  [2023, 208700, 118900, 18400, 137300],
  [2024, 224100, 102300, 31200, 133500],
  [2025, 251400, 78900, 42600, 121500],
  [2026, 282900, 23280, 51820, 75100],
];

// Named large losses, USD 000s FGU / to layer 2: [event, date, fgu, toLayer, status]
const LARGE_LOSSES = [
  ['Storm Bernd', '2021-07-14', 186400, 20000, 'Closed'],
  ['Hail — Rhein-Main', '2022-06-23', 241800, 20000, 'Closed'],
  ['Windstorm Ciarán', '2023-11-02', 98200, 20000, 'Open'],
  ['Flood — Emilia', '2024-10-19', 61700, 18400, 'Open'],
  ['Storm Éowyn', '2025-01-24', 44300, 11900, 'Open'],
  ['Hail — Bavaria', '2026-06-11', 32900, 6200, 'Advised'],
];





const K = 1000; // design figures are USD 000s

async function seedUsers() {
  const ids = {};
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    const { rows } = await query(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [u.email, u.name, hash, u.role],
    );
    ids[u.email] = rows[0].id;
    console.log(`seeded ${u.role}: ${u.email}`);
  }
  return ids;
}

/** A date `months` from today, as YYYY-MM-DD. */
function monthsOut(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Upsert one counterparty into the register and return its id. The demo book
 * is a live panel, so its counterparties come with a KYC file already signed
 * off and in date — an unonboarded market is one you would not be placing with.
 */
async function upsertMarket({ name, domicile, type, rating = null, region = null }) {
  const { rows } = await query(
    `INSERT INTO market (name, domicile, type, rating, region, rating_agency, rating_as_of,
                         kyc_status, kyc_reviewed_at, kyc_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8,$9)
     ON CONFLICT (type, name, domicile) DO UPDATE SET
       rating = EXCLUDED.rating, region = EXCLUDED.region,
       rating_agency = EXCLUDED.rating_agency, rating_as_of = EXCLUDED.rating_as_of,
       kyc_status = EXCLUDED.kyc_status, kyc_reviewed_at = EXCLUDED.kyc_reviewed_at,
       kyc_expires_at = EXCLUDED.kyc_expires_at
     RETURNING id`,
    [name, domicile, type, rating, region,
      rating ? 'AM Best' : null, rating ? monthsOut(-4) : null,
      monthsOut(-8), monthsOut(16)],
  );
  return rows[0].id;
}

async function upsertRegister() {
  const cedants = {};
  for (const [name, domicile, region] of CEDANTS) {
    // A cedant is the insurer side of the register, so it gets an entry there
    // too — that is where its KYC file, group profile and region hang.
    const marketId = await upsertMarket({ name, domicile, type: 'insurer', region });
    const { rows } = await query(
      `INSERT INTO cedant (name, domicile, market_id) VALUES ($1,$2,$3)
       ON CONFLICT (name, domicile) DO UPDATE SET
         domicile = EXCLUDED.domicile, market_id = EXCLUDED.market_id
       RETURNING id`,
      [name, domicile, marketId],
    );
    cedants[name] = rows[0].id;
  }
  const markets = {};
  for (const [name, domicile, rating, region] of MARKETS) {
    markets[name] = await upsertMarket({ name, domicile, type: 'reinsurer', rating, region });
  }
  for (const [name, domicile, region] of BROKERS) {
    await upsertMarket({ name, domicile, type: 'broker', region });
  }
  return { cedants, markets };
}

async function insertPlacement(p) {
  const { rows } = await query(
    `INSERT INTO placement (reference, cedant_id, class, inception, expiry, currency, renewal_of, est_gwp, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (reference) DO NOTHING RETURNING id`,
    [p.reference, p.cedant_id, p.class, p.inception, p.expiry, p.currency || 'USD',
      p.renewal_of || null, p.est_gwp ?? null, p.status || 'DRAFT', p.created_by || null],
  );
  return rows[0]?.id;
}

async function insertLayer(l) {
  const { rows } = await query(
    `INSERT INTO layer (placement_id, name, type, attachment, limit_amt, order_pct, premium100, currency, status, position, brokerage_pct)
     VALUES ($1,$2,'XoL',$3,$4,$5,$6,'USD',$7,$8,$9) RETURNING id`,
    [l.placement_id, l.name, l.attachment, l.limit, l.order ?? 100, l.premium ?? 0, l.status || 'OPEN', l.position ?? 0, l.brokerage ?? 0],
  );
  return rows[0].id;
}

async function seedBook(users, cedants, markets) {
  const exists = await query("SELECT 1 FROM placement WHERE reference = 'GRV-27-PROP-CAT'");
  if (exists.rowCount) {
    console.log('demo book already present — skipping');
    return;
  }
  const vance = users['a.vance@broking.local'];
  const reyes = users['m.reyes@broking.local'];
  const admin = users['admin@broking.local'];

  // --- The Grievous Mutual renewal chain: 2025 → 2026 → 2027 ---
  const grv25 = await insertPlacement({
    reference: 'GRV-25-PROP-CAT', cedant_id: cedants['Grievous Mutual'], class: 'Property CAT XL',
    inception: '2025-01-01', expiry: '2025-12-31', est_gwp: 58.1e6, status: 'LAPSED', created_by: vance,
  });
  const grv26 = await insertPlacement({
    reference: 'GRV-26-PROP-CAT', cedant_id: cedants['Grievous Mutual'], class: 'Property CAT XL',
    inception: '2026-01-01', expiry: '2026-12-31', renewal_of: grv25, est_gwp: 62.8e6, status: 'BOUND', created_by: vance,
  });
  const grv27 = await insertPlacement({
    reference: 'GRV-27-PROP-CAT', cedant_id: cedants['Grievous Mutual'], class: 'Property CAT XL',
    inception: '2027-01-01', expiry: '2027-12-31', renewal_of: grv26, est_gwp: 68.4e6, status: 'LINES_WRITTEN', created_by: vance,
  });

  // Prior-year packs (renewal sources for the 2027 pack wizard).
  await query(
    `INSERT INTO renewal_pack (placement_id, version, snapshot, status, created_by, approved_by, approved_at, created_at)
     VALUES ($1,6,$2,'approved',$3,$4,'2024-11-28T10:00:00Z','2024-11-20T10:00:00Z')`,
    [grv25, JSON.stringify({
      summary_note: 'Useful only for the 10-year claims exhibit; structure changed at the 2026 renewal (layer 1 retention moved).',
    }), vance, admin],
  );
  await query(
    `INSERT INTO renewal_pack (placement_id, version, snapshot, status, created_by, approved_by, approved_at, created_at)
     VALUES ($1,4,$2,'approved',$3,$4,'2025-12-02T10:00:00Z','2025-11-24T10:00:00Z')`,
    [grv26, JSON.stringify({
      summary_note: '10 sections, 12-market panel, wording at v7. Placed 100% at ROL 14.10%, signed down from 118.5% written.',
      sections: [
        'Cover letter & submission', 'Programme structure', 'Exposure summary by band',
        'Claims experience, 10 years', 'Large loss listing', 'Rate change history',
        'Cat model output', 'Contract wording', 'Reinsurer panel & signed lines',
        'Cedant financials & ESG',
      ],
    }), vance, admin],
  );

  // Programme structures. Layer 2 of the 2027 programme is the design's layer:
  // USD 20m xs USD 10m, order 100%, premium 100% = USD 27.5m.
  const structure = [
    { name: 'USD 5m xs USD 5m', attachment: 5e6, limit: 5e6, premium: 8.2e6 },
    { name: 'USD 20m xs USD 10m', attachment: 10e6, limit: 20e6, premium: 27.5e6 },
    { name: 'USD 30m xs USD 30m', attachment: 30e6, limit: 30e6, premium: 4.9e6 },
    { name: 'USD 40m xs USD 60m', attachment: 60e6, limit: 40e6, premium: 3.6e6 },
  ];
  for (const [i, l] of structure.entries()) {
    await insertLayer({ placement_id: grv26, ...l, premium: l.premium * 0.92, status: 'BOUND', position: i + 1, brokerage: 10 });
  }
  let grvLayer2;
  for (const [i, l] of structure.entries()) {
    const status = i === 1 ? 'FOT_AGREED' : 'OPEN';
    // 10% brokerage, as every other placed layer in the demo book carries: what
    // the programme is worth once placed, and the return a market visit to the
    // cedant reads on Market intelligence.
    const id = await insertLayer({ placement_id: grv27, ...l, status, position: i + 1, brokerage: 10 });
    if (i === 1) grvLayer2 = id;
  }

  // Marketing on layer 2: approaches + quotes + subjectivities.
  for (const [market, role, type, rol, line, status, validity, subjectivities] of QUOTES) {
    const approachStatus = status === 'accepted' ? 'AGREED' : 'QUOTED';
    const { rows: aRows } = await query(
      `INSERT INTO approach (layer_id, market_id, role, sent_date, status)
       VALUES ($1,$2,$3,'2026-07-20',$4) RETURNING id`,
      [grvLayer2, markets[market], role, approachStatus],
    );
    const { rows: qRows } = await query(
      `INSERT INTO quote (approach_id, type, rol, line_offered, validity, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [aRows[0].id, type, rol, line, validity, status, vance],
    );
    for (const text of subjectivities) {
      await query('INSERT INTO subjectivity (quote_id, text) VALUES ($1,$2)', [qRows[0].id, text]);
    }
  }

  // Firm order terms: v1 superseded, v2 authorised by a second pair of eyes.
  await query(
    `INSERT INTO fot (layer_id, version, agreed_terms, status, proposed_by, agreed_date, created_at)
     VALUES ($1,1,$2,'superseded',$3,'2026-08-02','2026-08-02T15:00:00Z')`,
    [grvLayer2, JSON.stringify({ rol: 15.4, order_pct: 100, reinstatements: '2 @ 100% pro rata' }), vance],
  );
  await query(
    `INSERT INTO fot (layer_id, version, agreed_terms, status, proposed_by, authorised_by, agreed_date, authorised_at, created_at)
     VALUES ($1,2,$2,'authorised',$3,$4,'2026-08-14','2026-08-14T09:12:00Z','2026-08-13T16:40:00Z')`,
    [grvLayer2, JSON.stringify({
      rol: 15.25, order_pct: 100, reinstatements: '2 @ 100% pro rata', no_claims_bonus: '5%',
    }), vance, reyes],
  );

  // The written panel: 12 lines, 107.50% against a 100% order.
  for (const [i, [market, ref, written]] of PANEL.entries()) {
    const { rows: aRows } = await query(
      'SELECT id FROM approach WHERE layer_id = $1 AND market_id = $2', [grvLayer2, markets[market]],
    );
    await query(
      `INSERT INTO line (layer_id, market_id, approach_id, written_pct, market_ref, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,'WRITTEN',$6,$7)`,
      [grvLayer2, markets[market], aRows[0]?.id || null, written, ref, vance,
        new Date(Date.UTC(2026, 7, 15 + Math.floor(i / 3), 9 + (i % 3) * 3)).toISOString()],
    );
  }
  await query(
    "UPDATE approach SET status = 'WRITTEN' WHERE layer_id = $1 AND status = 'QUOTED'", [grvLayer2],
  );

  // Audit trail for the signing worksheet.
  const AUDIT = [
    ['2026-08-14T09:12:00Z', reyes, 'fot_authorise', 'FOT v2 authorised by M. Reyes (four-eyes)'],
    ['2026-08-18T14:40:00Z', vance, 'line_write', '12th line written — Lancashire 5.00%'],
    ['2026-08-18T15:02:00Z', vance, 'stand_set', 'Swiss Re line set to stand by A. Vance'],
    ['2026-08-18T15:04:00Z', vance, 'stand_clear', 'Swiss Re stand released — full panel signs down'],
    ['2026-08-18T15:06:00Z', vance, 'signing_preview', 'Signing previewed — factor 0.930233'],
  ];
  for (const [at, userId, action, text] of AUDIT) {
    await query(
      `INSERT INTO audit_event (entity_type, entity_id, action, user_id, detail, created_at)
       VALUES ('layer',$1,$2,$3,$4,$5)`,
      [grvLayer2, action, userId, JSON.stringify({ text }), at],
    );
  }

  // Bordereaux: premium + claims histories (drive the 10-year exhibit), the
  // large-loss listing, the SI banding extract, and a superseded 2025 file.
  // Rows are seeded at the level a real bordereau carries — premium by quarter
  // and band, claims one row per claim — so row counts mean what they say and
  // each year still sums to the exhibit above to the cent.
  const spread = (total, n, seed) => {
    // Deterministic split of `total` across n rows; the last row absorbs the
    // rounding residual so the year total is exact.
    const parts = [];
    let used = 0;
    for (let i = 0; i < n - 1; i += 1) {
      const weight = 1 + (((i * 37 + seed * 11) % 23) - 11) / 40; // ±27% around even
      const v = Math.round((total / n) * weight * 100) / 100;
      parts.push(v);
      used += v;
    }
    parts.push(Math.round((total - used) * 100) / 100);
    return parts;
  };

  const BANDS = ['0-5m', '5-10m', '10-25m', '25-50m', '50m+'];
  const premiumRows = [];
  YEARS.forEach(([uy, premium], yi) => {
    // 4 quarters x 5 sum-insured bands per underwriting year.
    const cells = spread(premium * K, 4 * BANDS.length, yi + 1);
    let c = 0;
    for (let q = 1; q <= 4; q += 1) {
      for (const band of BANDS) {
        premiumRows.push({ uy, quarter: `Q${q}`, band, risks: 180 + ((yi * 7 + c) % 120), premium: cells[c] });
        c += 1;
      }
    }
  });

  const claimsRows = [];
  YEARS.forEach(([uy, , paid, outstanding, incurred], yi) => {
    // Claim counts fall away for the greener years, as reporting does.
    const n = [88, 94, 71, 96, 78, 112, 83, 69, 54, 31][yi];
    const paidParts = spread(paid * K, n, yi + 2);
    const osParts = spread(outstanding * K, n, yi + 3);
    for (let i = 0; i < n; i += 1) {
      const p = paidParts[i];
      const os = osParts[i];
      claimsRows.push({
        uy,
        claim_ref: `GRV/${uy}/${String(i + 1).padStart(4, '0')}`,
        loss_date: `${uy}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
        peril: ['Windstorm', 'Flood', 'Hail', 'Fire', 'Subsidence'][i % 5],
        paid: p,
        outstanding: os,
        incurred: Math.round((p + os) * 100) / 100,
        status: os > 0 ? 'Open' : 'Closed',
      });
    }
    // incurred is paid + outstanding by construction, matching the exhibit.
    void incurred;
  });

  // The large-loss listing: the six named events plus the attritional losses
  // over the USD 5m FGU reporting threshold. It is a reported-level view of
  // the same claims, so it is summarised to zero and excluded from the totals.
  const largeLossRows = LARGE_LOSSES.map(([event, date, fgu, toLayer, status]) => ({
    event, date, fgu: fgu * K, to_layer_2: toLayer * K, status,
  }));
  for (let i = 0; i < 81; i += 1) {
    const year = 2017 + (i % 10);
    const fgu = (5200 + ((i * 733) % 24000)) * K;
    largeLossRows.push({
      event: `Risk loss ${String(i + 1).padStart(2, '0')} — attritional`,
      date: `${year}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
      fgu,
      to_layer_2: Math.max(0, Math.min(fgu - 10e6, 20e6)),
      status: year < 2024 ? 'Closed' : 'Open',
    });
  }

  // Sum-insured banding: the exposure extract behind the exposure exhibit.
  const siRows = Array.from({ length: 12 }, (_, i) => ({
    band: `${i * 5}m–${(i + 1) * 5}m`, risks: 480 - i * 34, tsi: (3800 - i * 260) * 1e6,
  }));

  // Summaries are the sum of the rows actually seeded, so the bordereau
  // headline reconciles to its own detail.
  const sumOf = (rows, key) => Math.round(rows.reduce((a, r) => a + (r[key] || 0), 0) * 100) / 100;
  const totals = {
    premium: sumOf(premiumRows, 'premium'),
    paid: sumOf(claimsRows, 'paid'),
    outstanding: sumOf(claimsRows, 'outstanding'),
    incurred: sumOf(claimsRows, 'incurred'),
  };

  const BDX = [
    { type: 'premium', file: 'GRV_prem_2026Q1-Q4.csv', rows: premiumRows,
      summary: { label: '2026 premium bordereau', premium: totals.premium, state: 'reconciled' },
      start: '2017-01-01', end: '2026-12-31', at: '2026-08-12T09:00:00Z' },
    { type: 'claims', file: 'GRV_claims_asat_30Jun2026.csv', rows: claimsRows,
      summary: { label: '2026 claims bordereau', paid: totals.paid, outstanding: totals.outstanding, incurred: totals.incurred, state: 'reconciled' },
      start: '2017-01-01', end: '2026-06-30', at: '2026-08-14T09:00:00Z' },
    { type: 'claims', file: 'GRV_largeloss_10yr.xlsx', rows: largeLossRows,
      // Subset of the claims bordereau — zero-summarised so totals don't double-count.
      summary: { label: 'Large loss listing, 10 years', paid: 0, outstanding: 0, incurred: 0, state: 'reconciled', note: 'Large-loss subset of the claims bordereau' },
      start: '2017-01-01', end: '2026-06-30', at: '2026-08-14T09:05:00Z' },
    { type: 'premium', file: 'GRV_SI_bands_2026.csv', rows: siRows,
      summary: { label: 'Sum insured banding extract', premium: 0, state: 'warnings', warnings: 2, note: 'Sum-insured banding extract (exposure only)' },
      start: '2026-01-01', end: '2026-12-31', at: '2026-08-12T09:10:00Z' },
    { type: 'claims', file: 'GRV_claims_asat_31Dec2025.csv',
      rows: claimsRows.filter((r) => r.uy <= 2025),
      summary: { label: '2025 claims bordereau', paid: 0, outstanding: 0, incurred: 0, state: 'superseded' },
      start: '2016-01-01', end: '2025-12-31', at: '2026-01-09T09:00:00Z' },
  ];
  for (const b of BDX) {
    await query(
      `INSERT INTO bordereau (placement_id, type, source_file, period_start, period_end, parsed_rows, row_count, summary, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [grv27, b.type, b.file, b.start, b.end, JSON.stringify(b.rows), b.rows.length,
        JSON.stringify(b.summary), vance, b.at],
    );
  }

  // --- The rest of the 1 Jan 2027 renewal calendar ---
  const NAMED = [
    ['NORD-27-PROP-CAT', 'Nordkap Forsikring', 'Property CAT XL', 'QUOTED', 41.2e6],
    ['ALZ-27-PROP-RISK', 'Alzey Versicherung', 'Property Risk XL', 'PACK', 22.8e6],
    ['HELV-27-PROP-CAT', 'Helvetia Kantonal', 'Property CAT XL', 'FOT_AGREED', 55.1e6],
    ['IBER-27-MOT-QS', 'Iberia Mutua', 'Motor Quota Share', 'DATA', 31.6e6],
    ['BALT-27-MAR-XL', 'Baltica Marine', 'Marine XL', 'DRAFT', 18.9e6],
    ['TYRR-27-PROP-CAT', 'Tyrrhenia Assicura', 'Property CAT XL', 'LEAD_MARKETING', 29.3e6, '2027-04-01', '2028-03-31'],
  ];
  const named = {};
  for (const [reference, cedant, cls, status, gwp, inception = '2027-01-01', expiry = '2027-12-31'] of NAMED) {
    named[reference] = await insertPlacement({
      reference, cedant_id: cedants[cedant], class: cls, inception, expiry,
      est_gwp: gwp, status, created_by: vance,
    });
  }

  // A pack awaiting analyst approval on the Alzey renewal.
  await query(
    `INSERT INTO renewal_pack (placement_id, version, snapshot, status, created_by, created_at)
     VALUES ($1,1,$2,'draft',$3,'2026-08-19T11:00:00Z')`,
    [named['ALZ-27-PROP-RISK'], JSON.stringify({ summary_note: 'First 2027 build — awaiting approval.' }), vance],
  );

  // Quotes past validity (Nordkap) and the subjectivities blocking Helvetia's FOT.
  const nordLayer = await insertLayer({
    placement_id: named['NORD-27-PROP-CAT'], name: 'USD 15m xs USD 10m',
    attachment: 10e6, limit: 15e6, premium: 2.1e6, position: 1,
  });
  const { rows: nordA } = await query(
    `INSERT INTO approach (layer_id, market_id, role, sent_date, status)
     VALUES ($1,$2,'lead','2026-07-01','QUOTED') RETURNING id`,
    [nordLayer, markets['Hannover Re']],
  );
  await query(
    `INSERT INTO quote (approach_id, type, rol, line_offered, validity, status, created_by)
     VALUES ($1,'firm',13.4,25,'2026-08-01','active',$2)`,
    [nordA[0].id, vance],
  );

  const helvLayer = await insertLayer({
    placement_id: named['HELV-27-PROP-CAT'], name: 'USD 25m xs USD 15m',
    attachment: 15e6, limit: 25e6, premium: 3.4e6, position: 1,
  });
  const { rows: helvA } = await query(
    `INSERT INTO approach (layer_id, market_id, role, sent_date, status)
     VALUES ($1,$2,'lead','2026-06-15','AGREED') RETURNING id`,
    [helvLayer, markets['Swiss Re']],
  );
  const { rows: helvQ } = await query(
    `INSERT INTO quote (approach_id, type, rol, line_offered, validity, status, created_by)
     VALUES ($1,'firm',12.1,30,'2026-09-30','accepted',$2) RETURNING id`,
    [helvA[0].id, vance],
  );
  for (const text of ['Signed 2025 statutory accounts', 'Cat aggregates by CRESTA zone']) {
    await query('INSERT INTO subjectivity (quote_id, text) VALUES ($1,$2)', [helvQ[0].id, text]);
  }

  // --- Filler book: the rest of the 38-placement pipeline ---
  // Statuses beyond the named placements; inception outside the calendar window.
  const FILLER = [
    ['DRAFT', 5], ['DATA', 4], ['PACK', 8], ['LEAD_MARKETING', 3],
    ['QUOTED', 4], ['FOT_AGREED', 2], ['LINES_WRITTEN', 2], ['SIGNED', 2],
  ];
  const cedantNames = CEDANTS.map(([n]) => n);
  const classes = ['Property CAT XL', 'Property Risk XL', 'Motor Quota Share', 'Marine Risk XL', 'Liability Risk XL'];
  let n = 0;
  let approvedPacks = 0;
  let pastValidity = 0;
  let shortfalls = 0;
  for (const [status, count] of FILLER) {
    for (let i = 0; i < count; i++) {
      n += 1;
      const ref = `BOOK-27-${String(n).padStart(3, '0')}`;
      const id = await insertPlacement({
        reference: ref,
        cedant_id: cedants[cedantNames[n % cedantNames.length]],
        class: classes[n % classes.length],
        inception: '2027-06-01', expiry: '2028-05-31',
        est_gwp: 2.73e6, status, created_by: vance,
      });
      if (!id) continue;
      if (status === 'PACK') {
        await query(
          `INSERT INTO renewal_pack (placement_id, version, snapshot, status, created_by)
           VALUES ($1,1,'{}','draft',$2)`, [id, vance],
        );
      }
      if (['LEAD_MARKETING', 'QUOTED', 'FOT_AGREED', 'LINES_WRITTEN'].includes(status) && approvedPacks < 9) {
        approvedPacks += 1;
        await query(
          `INSERT INTO renewal_pack (placement_id, version, snapshot, status, created_by, approved_by, approved_at)
           VALUES ($1,1,'{}','approved',$2,$3,'2026-07-30T10:00:00Z')`, [id, vance, admin],
        );
      }
      if (status === 'QUOTED' && pastValidity < 4) {
        pastValidity += 1;
        const layerId = await insertLayer({
          placement_id: id, name: 'USD 10m xs USD 10m', attachment: 10e6, limit: 10e6, premium: 1.2e6, position: 1,
        });
        const mkt = ['Aspen Bermuda', 'Chubb Re', 'Fidelis MGU', 'Convex Re'][pastValidity - 1];
        const { rows: aRows } = await query(
          `INSERT INTO approach (layer_id, market_id, role, sent_date, status)
           VALUES ($1,$2,'lead','2026-06-20','QUOTED') RETURNING id`,
          [layerId, markets[mkt]],
        );
        await query(
          `INSERT INTO quote (approach_id, type, rol, line_offered, validity, status, created_by)
           VALUES ($1,'firm',11.2,20,'2026-07-15','active',$2)`,
          [aRows[0].id, vance],
        );
      }
      if (status === 'LINES_WRITTEN' && shortfalls < 2) {
        shortfalls += 1;
        const layerId = await insertLayer({
          placement_id: id, name: 'USD 10m xs USD 5m', attachment: 5e6, limit: 10e6, premium: 1.6e6,
          status: 'FOT_AGREED', position: 1,
        });
        await query(
          `INSERT INTO line (layer_id, market_id, written_pct, status, created_by)
           VALUES ($1,$2,$3,'WRITTEN',$4)`,
          [layerId, markets[shortfalls === 1 ? 'Hannover Re' : 'Ariel Re 1910'], shortfalls === 1 ? 85 : 90, vance],
        );
      }
    }
  }

  // --- Accounts another house leads ---
  // On these we hold a share of the order (§1.4) rather than the full 100%,
  // and the Final Placement stage has recorded who leads them — the lead
  // broker and the lead reinsurer — so the portfolio intelligence screen
  // shows both sides of the book: the accounts we lead, the ones we follow,
  // and which house places each.
  //   [reference, our order %, lead broker, lead reinsurer, treaty type,
  //    final placement status, our lines: [market, written %]]
  const FOLLOW = [
    ['BOOK-27-025', 35, 'Guy Carpenter', 'Munich Re', 'CAT XL', 'draft', [['Munich Re', 20], ['Hannover Re', 15]]],
    ['BOOK-27-029', 25, 'Aon Re', 'SCOR SE', 'Risk XL', 'confirmed', [['SCOR SE', 15], ['Lancashire', 10]]],
    ['BOOK-27-030', 50, 'Howden Re', 'Hannover Re', 'CAT XL', 'confirmed', [['Hannover Re', 30], ['Everest Re', 20]]],
  ];
  for (const [reference, order, leadBroker, leadReinsurer, treatyType, finalStatus, lines] of FOLLOW) {
    const { rows: pRows } = await query('SELECT id, status FROM placement WHERE reference = $1', [reference]);
    if (!pRows[0]) continue;
    const placementId = pRows[0].id;
    const signed = pRows[0].status === 'SIGNED';
    const premium = 1.6e6;
    const layerId = await insertLayer({
      placement_id: placementId, name: 'USD 10m xs USD 5m', attachment: 5e6, limit: 10e6,
      premium, order, status: signed ? 'SIGNED' : 'FOT_AGREED', position: 1,
    });
    await query('UPDATE layer SET brokerage_pct = 10 WHERE id = $1', [layerId]);
    for (const [market, written] of lines) {
      // The lead reinsurer leads the whole programme through the other house;
      // the rest of our panel follows it.
      const { rows: aRows } = await query(
        `INSERT INTO approach (layer_id, market_id, role, sent_date, status)
         VALUES ($1,$2,$3,'2026-07-06',$4) RETURNING id`,
        [layerId, markets[market], market === leadReinsurer ? 'lead' : 'follow', signed ? 'SIGNED' : 'WRITTEN'],
      );
      const premiumSigned = signed ? Math.round(premium * written) / 100 : null;
      await query(
        `INSERT INTO line (layer_id, market_id, approach_id, written_pct, signed_pct, premium_signed, brokerage_amount, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [layerId, markets[market], aRows[0].id, written, signed ? written : null, premiumSigned,
          premiumSigned == null ? null : Math.round(premiumSigned * 10) / 100, signed ? 'SIGNED' : 'WRITTEN', vance],
      );
    }
    await query(
      `INSERT INTO final_placement (placement_id, lead_won, lead_broker, lead_reinsurer_id, lead_reinsurer_name, treaty_type, status, confirmed_by, confirmed_at, created_by)
       VALUES ($1, FALSE, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [placementId, leadBroker, markets[leadReinsurer], leadReinsurer, treatyType, finalStatus,
        finalStatus === 'confirmed' ? vance : null, finalStatus === 'confirmed' ? '2026-08-20T10:00:00Z' : null, vance],
    );
  }

  // The 2026 Grievous Mutual programme we led and bound: who led it is on record.
  await query(
    `INSERT INTO final_placement (placement_id, lead_won, lead_broker, lead_reinsurer_id, lead_reinsurer_name, treaty_type, status, confirmed_by, confirmed_at, created_by)
     VALUES ($1, TRUE, $4, $2, 'Swiss Re', 'CAT XL', 'confirmed', $3, '2025-12-18T10:00:00Z', $3)`,
    [grv26, markets['Swiss Re'], vance, HOUSE],
  );

  console.log(`seeded demo book: ${3 + Object.keys(named).length + n} placements (GRV-27 layer 2: ${grvLayer2})`);
}


/**
 * Drop the demo book: placements and everything hanging off them. Users, the
 * register and the wording library are left alone. Renewal chains self-
 * reference via `renewal_of`, so placements go newest-first.
 */
async function resetBook() {
  const { rows } = await query(
    'SELECT id FROM placement ORDER BY (renewal_of IS NULL), created_at DESC',
  );
  for (const r of rows) await query('DELETE FROM placement WHERE id = $1', [r.id]);
  // The audit trail of the dropped book is left in place: §2.2 makes
  // audit_event append-only, enforced by a trigger since migration 026. The
  // orphaned rows are harmless noise in a development database, and deleting
  // them is exactly the habit the append-only rule exists to prevent.
  console.log(`reset demo book: removed ${rows.length} placements`);
}

async function main() {
  await up({ silent: true });
  const users = await seedUsers();
  if (process.env.SEED_DEMO_BOOK !== '0') {
    if (process.env.SEED_RESET === '1') await resetBook();
    const { cedants, markets } = await upsertRegister();
    await seedBook(users, cedants, markets);
    // A named underwriter at every reinsurer, so a pack can go to market.
    await seedUnderwriterContacts(users);
    // Three placements with every screen filled and a renewal pack each:
    // proportional only, non-proportional only, and both.
    await seedDemoPacks(users, cedants);
  }

  // Wording library: the top reinsurers, the standard clause corpus and the
  // reinsurer house wordings. Never overwrites clauses already in the library.
  const wordings = await seedWordingLibrary();
  console.log(
    `seeded wording library: ${wordings.reinsurers} reinsurers, `
    + `${wordings.standard} standard clauses, ${wordings.market} house clauses`,
  );

  // The authentic market forms (LMA / Institute / BRMA), laid over the
  // illustrative placeholders. Never overwrites a clause a firm has edited.
  const market = await seedMarketClauses();
  console.log(
    `seeded market-standard clauses: ${market.upgraded} upgraded, ${market.inserted} inserted`
    + `${market.skipped ? `, ${market.skipped} left alone (edited locally)` : ''}`,
  );

  // Tell the boot-time loader the library is accounted for on this database.
  await markWordingLibrarySeeded({ ...wordings, ...market, via: 'seed' });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
