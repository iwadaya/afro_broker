/**
 * Capital regimes — the solvency rules an insurer's country of domicile holds
 * it to, as reference data for the dynamic financial analysis.
 *
 * The CAS DFA Handbook asks the actuary to read every scenario's effect on
 * the regulatory monitors — "RBC and the impact of various business
 * strategies on RBC results", the "maximum withstandable strain" before the
 * capital ratio falls below an action level — so the desk needs to know, for
 * the insurer being modelled, which regime applies and where its action
 * levels sit. Each record answers, for one country:
 *
 *   - family      Solvency II (or a direct equivalent), risk-based capital,
 *                 a Solvency I-style solvency margin, or a fixed minimum
 *                 capital.
 *   - style       whether the requirement is factor-based (charges on
 *                 balance-sheet items, the NAIC model) or economic (a
 *                 market-consistent balance sheet at a stated confidence).
 *   - requirement the capital requirement in a sentence, and the ratio the
 *                 regulator reads (numerator over denominator).
 *   - calibration the confidence level and risk measure the requirement is
 *                 calibrated to, when it has one.
 *   - ladder      the intervention levels, top down: the ratio band the
 *                 insurer is in, and what the regulator does there.
 *   - proxy       how the DFA's modelled capital stands in for the regime's
 *                 requirement when the regulatory figure itself is not typed:
 *                 the modelled capital at `measure` / `confidence` is read as
 *                 the capital the regime expects to be held, i.e. the amount
 *                 that puts the ratio at `at_pct`. Null where nothing
 *                 modelled can stand in (a fixed minimum capital).
 *
 * This is a reference summary as at 2026, kept deliberately short: it says
 * which regime a country runs and where the ladder's rungs are, not the
 * whole rulebook. Thresholds and minimums move; the desk says so on screen.
 */

export const AS_AT = '2026';

export const REGIME_FAMILIES = {
  solvency_ii: {
    label: 'Solvency II',
    text: 'A market-consistent balance sheet with a Solvency Capital Requirement at the 99.5% one-year value at risk and a Minimum Capital Requirement beneath it. The ratio the regulator reads is eligible own funds over the SCR.',
  },
  rbc: {
    label: 'Risk-based capital',
    text: 'Required capital built up from risk charges — factor-based (the NAIC model and its Asian and African cousins) or a calibrated economic model — read as available capital over the requirement, with intervention levels down the ladder.',
  },
  solvency_margin: {
    label: 'Solvency margin',
    text: 'A Solvency I-style margin: a fixed share of premiums or of claims, whichever is higher, that available assets must cover. Not sensitive to the risk actually written.',
  },
  minimum_capital: {
    label: 'Minimum capital',
    text: 'A fixed minimum paid-up capital, usually with a simple solvency margin beside it, rather than a risk-based requirement.',
  },
};

export const REGIME_STYLES = {
  economic: 'Economic — a market-consistent balance sheet at a stated confidence level',
  factor: 'Factor-based — charges applied to premiums, reserves and assets',
  fixed: 'Fixed — a minimum amount rather than a risk measure',
};

// ---- Ladders ----

const S2_LADDER = [
  { min_pct: 100, level: 'SCR met', tone: 'good', action: 'No regulatory action. The ORSA is expected to show a buffer above 100%.' },
  { min_pct: 45, level: 'SCR breached', tone: 'warn', action: 'A recovery plan to the supervisor within two months; SCR compliance restored within six months (extendable).' },
  { min_pct: 25, level: 'SCR breached · MCR at risk', tone: 'bad', action: 'The MCR sits between 25% and 45% of the SCR. Below it the finance scheme is due within one month and authorisation is withdrawn if the MCR is not restored within three months.' },
  { min_pct: 0, level: 'MCR breached', tone: 'bad', action: 'Short-term finance scheme within one month; authorisation withdrawn if the MCR is not restored within three months.' },
];

const NAIC_LADDER = [
  { min_pct: 200, level: 'No action', tone: 'good', action: 'Above every control level. (A trend test applies between 200% and 300% of the ACL when the combined ratio exceeds 120%.)' },
  { min_pct: 150, level: 'Company Action Level', tone: 'warn', action: 'The insurer files an RBC plan with the commissioner.' },
  { min_pct: 100, level: 'Regulatory Action Level', tone: 'warn', action: 'The commissioner examines the insurer and orders corrective action.' },
  { min_pct: 70, level: 'Authorized Control Level', tone: 'bad', action: 'The commissioner may take control of the insurer.' },
  { min_pct: 0, level: 'Mandatory Control Level', tone: 'bad', action: 'The commissioner must take control of the insurer.' },
];

/** A regime with one line: met above `threshold`, action below it. */
function twoBand(threshold, met, below, { middle } = {}) {
  const rows = [{ min_pct: threshold, level: met.level || 'Requirement met', tone: 'good', action: met.action }];
  if (middle) rows.push({ min_pct: middle.min_pct, level: middle.level, tone: 'warn', action: middle.action });
  rows.push({ min_pct: 0, level: below.level || 'Requirement not met', tone: 'bad', action: below.action });
  return rows;
}

const MARGIN_LADDER = twoBand(100,
  { level: 'Margin covered', action: 'Available assets cover the solvency margin.' },
  { level: 'Margin not covered', action: 'The regulator requires a capital injection or a plan to restore the margin, and can restrict new business.' });

const MINIMUM_LADDER = twoBand(100,
  { level: 'Minimum capital held', action: 'Capital is at or above the statutory minimum.' },
  { level: 'Below the minimum', action: 'Recapitalise within the period the regulator sets, or lose the licence.' });

// ---- Builders ----

const VAR995 = { measure: 'var', confidence: 99.5, horizon_years: 1 };
const TVAR99 = { measure: 'tvar', confidence: 99, horizon_years: 1 };

function solvencyII(code, country, regulator, extra = {}) {
  return {
    code,
    country,
    regime: 'Solvency II',
    family: 'solvency_ii',
    style: 'economic',
    regulator,
    requirement: 'Solvency Capital Requirement (SCR) at the 99.5% one-year value at risk of basic own funds, by the standard formula or an approved internal model; a Minimum Capital Requirement (MCR) by a linear formula, floored at 25% and capped at 45% of the SCR, with an absolute floor (about €2.7m for a non-life insurer and €3.9m for a reinsurer, as indexed). The 2025 review amendments apply from January 2027.',
    minimum: 'MCR: 25%–45% of the SCR, with the absolute floor',
    ratio: { label: 'SCR ratio', numerator: 'Eligible own funds', denominator: 'SCR' },
    calibration: VAR995,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 100 },
    ladder: S2_LADDER,
    transition: null,
    ...extra,
  };
}

function margin(code, country, regulator, requirement, extra = {}) {
  return {
    code,
    country,
    regime: 'Solvency margin',
    family: 'solvency_margin',
    style: 'factor',
    regulator,
    requirement,
    minimum: null,
    ratio: { label: 'Solvency margin cover', numerator: 'Available assets less liabilities', denominator: 'Required solvency margin' },
    calibration: null,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 100 },
    ladder: MARGIN_LADDER,
    transition: null,
    ...extra,
  };
}

function minimumCapital(code, country, regulator, requirement, extra = {}) {
  return {
    code,
    country,
    regime: 'Minimum capital',
    family: 'minimum_capital',
    style: 'fixed',
    regulator,
    requirement,
    minimum: null,
    ratio: { label: 'Minimum capital cover', numerator: 'Paid-up capital and reserves', denominator: 'Minimum capital requirement' },
    calibration: null,
    proxy: null,
    ladder: MINIMUM_LADDER,
    transition: null,
    ...extra,
  };
}

function rbc(code, country, regulator, spec) {
  return {
    code,
    country,
    family: 'rbc',
    style: 'factor',
    regulator,
    minimum: null,
    calibration: null,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 100 },
    transition: null,
    ...spec,
  };
}

// ---- The table ----

export const REGIMES = [
  // ── Europe ──
  solvencyII('FR', 'France', 'Autorité de contrôle prudentiel et de résolution (ACPR)'),
  solvencyII('DE', 'Germany', 'BaFin'),
  solvencyII('IT', 'Italy', 'IVASS'),
  solvencyII('ES', 'Spain', 'Dirección General de Seguros y Fondos de Pensiones (DGSFP)'),
  solvencyII('NL', 'Netherlands', 'De Nederlandsche Bank (DNB)'),
  solvencyII('BE', 'Belgium', 'National Bank of Belgium (NBB)'),
  solvencyII('SE', 'Sweden', 'Finansinspektionen'),
  solvencyII('NO', 'Norway', 'Finanstilsynet', { regime: 'Solvency II (EEA)' }),
  solvencyII('DK', 'Denmark', 'Finanstilsynet (Danish FSA)'),
  solvencyII('FI', 'Finland', 'Finanssivalvonta (FIN-FSA)'),
  solvencyII('AT', 'Austria', 'Finanzmarktaufsicht (FMA)'),
  solvencyII('PT', 'Portugal', 'Autoridade de Supervisão de Seguros e Fundos de Pensões (ASF)'),
  solvencyII('GR', 'Greece', 'Bank of Greece'),
  solvencyII('IE', 'Ireland', 'Central Bank of Ireland'),
  solvencyII('PL', 'Poland', 'Komisja Nadzoru Finansowego (KNF)'),
  solvencyII('GB', 'United Kingdom', 'Prudential Regulation Authority (PRA)', {
    regime: 'Solvency UK',
    requirement: 'Solvency II as retained and reformed (Solvency UK, 2024): a Solvency Capital Requirement at the 99.5% one-year value at risk of basic own funds, by the standard formula or an approved internal model, with a reformed risk margin; a Minimum Capital Requirement between 25% and 45% of the SCR, with sterling absolute floors set by the PRA.',
  }),
  {
    code: 'CH',
    country: 'Switzerland',
    regime: 'Swiss Solvency Test (SST)',
    family: 'rbc',
    style: 'economic',
    regulator: 'FINMA',
    requirement: 'Target capital is the 99% expected shortfall (tail value at risk) of the change in risk-bearing capital over one year on a market-consistent balance sheet, plus the market value margin. The SST ratio is risk-bearing capital over target capital.',
    minimum: 'Statutory minimum share capital by class (CHF 3m–20m)',
    ratio: { label: 'SST ratio', numerator: 'Risk-bearing capital', denominator: 'Target capital' },
    calibration: TVAR99,
    proxy: { measure: 'tvar', confidence: 99, at_pct: 100 },
    ladder: [
      { min_pct: 100, level: 'SST ratio met', tone: 'good', action: 'No intervention.' },
      { min_pct: 80, level: 'Below 100%', tone: 'warn', action: 'FINMA requires measures that restore the ratio within a set period.' },
      { min_pct: 33, level: 'Below 80%', tone: 'bad', action: 'FINMA intervenes: restrictions on business and dividends, a recovery plan.' },
      { min_pct: 0, level: 'Below 33%', tone: 'bad', action: 'Protective measures, up to withdrawal of the licence.' },
    ],
    transition: null,
  },
  rbc('TR', 'Turkey', 'Insurance and Private Pension Regulation and Supervision Agency (SEDDK)', {
    regime: 'Capital adequacy (risk-based)',
    requirement: 'Required capital is the higher of a Solvency I-style premium/claims margin and a risk-based method summing asset, reinsurance, underwriting, credit and market risk charges; equity must cover it.',
    ratio: { label: 'Capital adequacy ratio', numerator: 'Equity', denominator: 'Required capital' },
    ladder: twoBand(100,
      { level: 'Capital adequate', action: 'Equity covers the required capital.' },
      { level: 'Capital shortfall', action: 'SEDDK requires a capital increase or a remediation plan within the period it sets.' }),
  }),
  rbc('RU', 'Russia', 'Bank of Russia', {
    regime: 'Risk-based capital (Regulation 710-P)',
    requirement: 'Own funds must cover a requirement built from concentration, credit, market and insurance risk charges on a risk-sensitive balance sheet, phased in from 2021.',
    ratio: { label: 'Capital adequacy ratio', numerator: 'Own funds', denominator: 'Required capital' },
    ladder: twoBand(100,
      { level: 'Requirement met', action: 'Own funds cover the requirement.' },
      { level: 'Requirement not met', action: 'Supervisory measures and a restoration plan.' }),
  }),

  // ── Americas ──
  {
    code: 'US',
    country: 'United States',
    regime: 'NAIC Risk-Based Capital (RBC)',
    family: 'rbc',
    style: 'factor',
    regulator: 'State insurance departments, under the NAIC RBC model law',
    requirement: 'Risk-based capital by the NAIC property/casualty formula: asset, credit, underwriting (reserve and premium) and catastrophe risk charges combined with a covariance adjustment. Total Adjusted Capital (TAC) is read against the Authorized Control Level (ACL), which is half the RBC after covariance.',
    minimum: 'State minimum capital and surplus by line; the RBC action levels above',
    ratio: { label: 'RBC ratio', numerator: 'Total Adjusted Capital', denominator: 'Authorized Control Level RBC' },
    calibration: null,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 200 },
    ladder: NAIC_LADDER,
    transition: null,
  },
  {
    code: 'CA',
    country: 'Canada',
    regime: 'Minimum Capital Test (MCT)',
    family: 'rbc',
    style: 'factor',
    regulator: 'Office of the Superintendent of Financial Institutions (OSFI)',
    requirement: 'Capital available over minimum capital required — insurance, market, credit and operational risk charges less a diversification credit, calibrated to about the 99% conditional tail expectation over one year. A 100% minimum, a 150% supervisory target, and an internal target above that.',
    minimum: 'MCT 100%; supervisory target 150%',
    ratio: { label: 'MCT ratio', numerator: 'Capital available', denominator: 'Minimum capital required' },
    calibration: TVAR99,
    proxy: { measure: 'tvar', confidence: 99, at_pct: 100 },
    ladder: [
      { min_pct: 150, level: 'Above the supervisory target', tone: 'good', action: 'No intervention; the internal target sits higher still.' },
      { min_pct: 100, level: 'Below the 150% supervisory target', tone: 'warn', action: 'OSFI expects a plan to restore the target; staged intervention.' },
      { min_pct: 0, level: 'Below the 100% minimum', tone: 'bad', action: 'Regulatory action; OSFI may take control.' },
    ],
    transition: null,
  },
  {
    code: 'BM',
    country: 'Bermuda',
    regime: 'Bermuda Solvency Capital Requirement (BSCR)',
    family: 'rbc',
    style: 'factor',
    regulator: 'Bermuda Monetary Authority (BMA)',
    requirement: 'The Enhanced Capital Requirement (ECR) is the greater of the BSCR — a standard formula calibrated to the 99% tail value at risk over one year, or an approved internal model — and the Minimum Solvency Margin (MSM). The Target Capital Level is 120% of the ECR. Solvency II-equivalent for commercial insurers.',
    minimum: 'MSM: the greater of a fixed floor, a share of premiums or reserves, and 25% of the ECR',
    ratio: { label: 'ECR ratio', numerator: 'Statutory capital and surplus', denominator: 'Enhanced Capital Requirement' },
    calibration: TVAR99,
    proxy: { measure: 'tvar', confidence: 99, at_pct: 100 },
    ladder: [
      { min_pct: 120, level: 'Above the target capital level', tone: 'good', action: 'No intervention.' },
      { min_pct: 100, level: 'Below the 120% target', tone: 'warn', action: 'Closer BMA supervision; dividends may be restricted.' },
      { min_pct: 25, level: 'ECR breached', tone: 'bad', action: 'A capital restoration plan; the BMA may restrict business.' },
      { min_pct: 0, level: 'Below the minimum solvency margin', tone: 'bad', action: 'The MSM is at least 25% of the ECR: below it the BMA can take control.' },
    ],
    transition: null,
  },
  {
    code: 'MX',
    country: 'Mexico',
    regime: 'Solvency II-type (LISF 2015)',
    family: 'solvency_ii',
    style: 'economic',
    regulator: 'Comisión Nacional de Seguros y Fianzas (CNSF)',
    requirement: 'Requerimiento de Capital de Solvencia (RCS) at the 99.5% one-year value at risk by the CNSF general formula or an approved internal model, on a market-consistent balance sheet; a fixed minimum paid-up capital as an absolute floor.',
    minimum: 'Capital mínimo pagado, by class of business',
    ratio: { label: 'Solvency ratio', numerator: 'Own funds admissible', denominator: 'RCS' },
    calibration: VAR995,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 100 },
    ladder: twoBand(100,
      { level: 'RCS met', action: 'No regulatory action.' },
      { level: 'RCS shortfall', action: 'A regularisation plan to the CNSF; sanctions and intervention if the shortfall persists.' }),
    transition: null,
  },
  rbc('BR', 'Brazil', 'Superintendência de Seguros Privados (SUSEP)', {
    regime: 'Capital Mínimo Requerido (risk-based)',
    requirement: 'The Capital Mínimo Requerido (CMR) is the greater of the base capital and the risk capital — underwriting, credit, operational and market risk charges. Adjusted net worth must cover it.',
    ratio: { label: 'Solvency ratio', numerator: 'Adjusted net worth (PLA)', denominator: 'CMR' },
    ladder: twoBand(100,
      { level: 'CMR covered', action: 'No regulatory action.' },
      { level: 'CMR not covered', action: 'A recovery plan to SUSEP; a large or persistent shortfall brings fiscal direction and special regimes.' }),
  }),
  margin('CL', 'Chile', 'Comisión para el Mercado Financiero (CMF)',
    'Solvency I-style: a minimum patrimonio, leverage limits on obligations to patrimonio, and a solvency margin on premiums and claims. A risk-based capital regime (CBR) is being introduced under the recent reforms.',
    { transition: 'Risk-based capital (CBR) in introduction' }),
  margin('CO', 'Colombia', 'Superintendencia Financiera de Colombia',
    'Patrimonio adecuado: a factor-based margin on premiums and claims plus asset-risk charges, which patrimonio técnico must cover.'),
  margin('AR', 'Argentina', 'Superintendencia de Seguros de la Nación (SSN)',
    'Capital mínimo: the greater of fixed minimums by branch, a share of premiums and a share of claims.'),
  margin('PE', 'Peru', 'Superintendencia de Banca, Seguros y AFP (SBS)',
    'Patrimonio efectivo must cover the solvency margin (premium and claims methods) plus a guarantee fund set as a share of the margin.'),
  margin('EC', 'Ecuador', 'Superintendencia de Compañías, Valores y Seguros (SCVS)',
    'A solvency margin on premiums and claims plus minimum paid-up capital.'),
  margin('VE', 'Venezuela', 'Superintendencia de la Actividad Aseguradora (SUDEASEG)',
    'Minimum capital plus a solvency margin on premiums and claims.'),

  // ── East Asia & Pacific ──
  {
    code: 'JP',
    country: 'Japan',
    regime: 'Economic value-based solvency (ESR)',
    family: 'rbc',
    style: 'economic',
    regulator: 'Financial Services Agency (JFSA)',
    requirement: 'From the fiscal year ending March 2026, the Economic Solvency Ratio: eligible capital over a risk amount at the 99.5% one-year value at risk on a market-consistent balance sheet, aligned with the IAIS Insurance Capital Standard. The legacy Solvency Margin Ratio (200% line) is reported alongside through the transition.',
    minimum: 'ESR 100%',
    ratio: { label: 'ESR', numerator: 'Eligible capital', denominator: 'Risk amount' },
    calibration: VAR995,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 100 },
    ladder: twoBand(100,
      { level: 'ESR met', action: 'No supervisory measures.' },
      { level: 'ESR below 100%', action: 'Early-warning and supervisory measures; a capital plan, business improvement orders.' }),
    transition: 'ESR in force from FY2025; the Solvency Margin Ratio runs in parallel',
  },
  rbc('CN', 'China', 'National Financial Regulatory Administration (NFRA)', {
    regime: 'C-ROSS Phase II',
    style: 'economic',
    requirement: 'Minimum capital from quantifiable insurance, market and credit risk charges combined by a correlation matrix, at the 99.5% one-year value at risk; a core solvency ratio of at least 50%, a comprehensive solvency ratio of at least 100%, and an integrated risk rating of B or better.',
    minimum: 'Core ratio 50%; comprehensive ratio 100%',
    ratio: { label: 'Comprehensive solvency ratio', numerator: 'Actual capital', denominator: 'Minimum capital' },
    calibration: VAR995,
    ladder: [
      { min_pct: 100, level: 'Solvency adequate', tone: 'good', action: 'No regulatory measures (with the core ratio and risk rating also met).' },
      { min_pct: 50, level: 'Below the comprehensive 100%', tone: 'warn', action: 'NFRA measures: a capital plan, restrictions on business and dividends.' },
      { min_pct: 0, level: 'Below the core 50% line', tone: 'bad', action: 'Takeover or receivership.' },
    ],
  }),
  rbc('KR', 'South Korea', 'Financial Supervisory Service (FSS) / Financial Services Commission (FSC)', {
    regime: 'K-ICS',
    style: 'economic',
    requirement: 'Available capital over required capital at the 99.5% one-year value at risk on an economic balance sheet (2023). A 100% statutory minimum and a 150% supervisory recommendation, with transitional measures.',
    minimum: 'K-ICS ratio 100%; 150% recommended',
    ratio: { label: 'K-ICS ratio', numerator: 'Available capital', denominator: 'Required capital' },
    calibration: VAR995,
    ladder: [
      { min_pct: 150, level: 'Above the FSS recommendation', tone: 'good', action: 'No intervention.' },
      { min_pct: 100, level: 'Meets the 100% minimum, below the recommended 150%', tone: 'warn', action: 'Closer supervision; a capital plan is expected.' },
      { min_pct: 50, level: 'Management improvement recommendation', tone: 'bad', action: 'Prompt corrective action: the FSC recommends improvement measures.' },
      { min_pct: 0, level: 'Management improvement requirement or order', tone: 'bad', action: 'Prompt corrective action: capital increase, restrictions, up to transfer of the business.' },
    ],
  }),
  rbc('TW', 'Taiwan', 'Financial Supervisory Commission (FSC)', {
    regime: 'TW-ICS (from 2026)',
    style: 'economic',
    requirement: 'From 2026 the Taiwan Insurance Capital Standard, a localised ICS phased in over fifteen years: capital over required capital at the 99.5% one-year value at risk. The RBC ratio (adjusted net capital over risk-based capital, 200% line) applies through the transition.',
    minimum: 'TW-ICS ratio 100% (RBC 200% in transition)',
    ratio: { label: 'TW-ICS ratio', numerator: 'Eligible capital', denominator: 'Required capital' },
    calibration: VAR995,
    ladder: twoBand(100,
      { level: 'Requirement met', action: 'No intervention.' },
      { level: 'Capital inadequate', action: 'Corrective measures by the FSC, escalating with the shortfall.' }),
    transition: 'TW-ICS phased in from 2026; RBC 200% during the transition',
  }),
  rbc('HK', 'Hong Kong', 'Insurance Authority (IA)', {
    regime: 'Hong Kong Risk-Based Capital (HKRBC)',
    style: 'economic',
    requirement: 'From July 2024 the Prescribed Capital Requirement (PCR) at the 99.5% one-year value at risk on an economic balance sheet, with a Minimum Capital Requirement beneath it as a floor. The solvency ratio is eligible capital over the PCR.',
    minimum: 'PCR 100%; the MCR as a floor',
    ratio: { label: 'Solvency ratio', numerator: 'Eligible capital', denominator: 'PCR' },
    calibration: VAR995,
    ladder: twoBand(100,
      { level: 'PCR met', action: 'No intervention.' },
      { level: 'Below the PCR', action: 'The IA requires a capital plan and may restrict business; below the MCR, stricter measures.' }),
  }),
  rbc('AU', 'Australia', 'Australian Prudential Regulation Authority (APRA)', {
    regime: 'LAGIC (GPS 110)',
    requirement: 'The Prescribed Capital Amount from insurance, insurance concentration, asset, asset concentration and operational risk charges at the 99.5% one-year value at risk; the Prudential Capital Requirement is the PCA plus any supervisory adjustment, and the capital base must exceed it, with an ICAAP target above. Minimum A$5m.',
    minimum: 'PCR 100%; minimum capital A$5m',
    ratio: { label: 'PCA coverage', numerator: 'Capital base', denominator: 'Prescribed Capital Amount' },
    calibration: VAR995,
    ladder: twoBand(100,
      { level: 'Above the PCR', action: 'No intervention (the ICAAP target sits higher).' },
      { level: 'Below the PCR', action: 'APRA intervention: a capital plan, restrictions on business and dividends.' }),
  }),
  rbc('NZ', 'New Zealand', 'Reserve Bank of New Zealand (RBNZ)', {
    regime: 'Interim Solvency Standard (2023)',
    requirement: 'The Prescribed Capital Requirement from insurance, asset and other risk charges plus a fixed capital charge; the solvency ratio is actual solvency capital over the PCR, with a Minimum Solvency Capital floor beneath it. Minimum capital NZ$5m for a general insurer.',
    minimum: 'Solvency ratio 100%; minimum capital NZ$5m',
    ratio: { label: 'Solvency ratio', numerator: 'Actual solvency capital', denominator: 'PCR' },
    ladder: twoBand(100,
      { level: 'PCR met', action: 'No intervention.' },
      { level: 'Below the PCR', action: 'Licence conditions and supervisory action; below the minimum solvency capital, stricter measures.' }),
  }),

  // ── Southeast Asia ──
  rbc('SG', 'Singapore', 'Monetary Authority of Singapore (MAS)', {
    regime: 'RBC 2',
    requirement: 'The Capital Adequacy Ratio is financial resources over the total risk requirement — insurance, market, credit and operational risk charges at the 99.5% one-year value at risk. The Prescribed Capital Requirement is 100% and the Minimum Capital Requirement 50%.',
    minimum: 'PCR 100%; MCR 50%',
    ratio: { label: 'CAR', numerator: 'Financial resources', denominator: 'Total risk requirement' },
    calibration: VAR995,
    ladder: [
      { min_pct: 100, level: 'Above the PCR', tone: 'good', action: 'No intervention.' },
      { min_pct: 50, level: 'Below the PCR', tone: 'warn', action: 'MAS expects a plan and may restrict business.' },
      { min_pct: 0, level: 'Below the MCR', tone: 'bad', action: 'MAS may withdraw the licence.' },
    ],
  }),
  rbc('MY', 'Malaysia', 'Bank Negara Malaysia (BNM)', {
    regime: 'Risk-Based Capital Framework',
    requirement: 'The Capital Adequacy Ratio is total capital available over total capital required — credit, market, insurance and operational risk charges. A supervisory target of 130%, with an individual target capital level set above it.',
    minimum: 'CAR 100%; supervisory target 130%',
    ratio: { label: 'CAR', numerator: 'Total capital available', denominator: 'Total capital required' },
    ladder: [
      { min_pct: 130, level: 'Above the supervisory target', tone: 'good', action: 'No intervention.' },
      { min_pct: 100, level: 'Below the 130% supervisory target', tone: 'warn', action: 'BNM supervisory action and a capital plan.' },
      { min_pct: 0, level: 'Below 100%', tone: 'bad', action: 'Restrictions on business; a capital injection is required.' },
    ],
  }),
  rbc('TH', 'Thailand', 'Office of Insurance Commission (OIC)', {
    regime: 'RBC 2',
    requirement: 'The Capital Adequacy Ratio is total capital available over total capital required — insurance, market, credit, concentration and operational risk charges. A 100% minimum and a 140% supervisory level.',
    minimum: 'CAR 100%; supervisory level 140%',
    ratio: { label: 'CAR', numerator: 'Total capital available', denominator: 'Total capital required' },
    ladder: [
      { min_pct: 140, level: 'Above the supervisory level', tone: 'good', action: 'No intervention.' },
      { min_pct: 100, level: 'Below the 140% supervisory level', tone: 'warn', action: 'OIC supervisory action and a capital plan.' },
      { min_pct: 0, level: 'Below 100%', tone: 'bad', action: 'Restrictions on business; recapitalisation ordered.' },
    ],
  }),
  rbc('ID', 'Indonesia', 'Otoritas Jasa Keuangan (OJK)', {
    regime: 'Risk-based capital (MMBR)',
    requirement: 'The solvency level is admitted assets less liabilities over the minimum risk-based capital (MMBR); a 120% target and a 100% minimum. Minimum equity is being raised in steps to 2028.',
    minimum: 'Solvency 120% target, 100% minimum; rising minimum equity',
    ratio: { label: 'RBC ratio', numerator: 'Admitted assets less liabilities', denominator: 'Minimum risk-based capital' },
    ladder: [
      { min_pct: 120, level: 'Meets the 120% target', tone: 'good', action: 'No intervention.' },
      { min_pct: 100, level: 'Below the 120% target', tone: 'warn', action: 'A financial restructuring plan to OJK.' },
      { min_pct: 0, level: 'Below the 100% minimum', tone: 'bad', action: 'Restrictions on business; recapitalisation ordered.' },
    ],
  }),
  rbc('PH', 'Philippines', 'Insurance Commission (IC)', {
    regime: 'RBC 2',
    requirement: 'Available capital over risk-based capital — credit, insurance, market and operational risk charges — with a ratio of at least 100%, alongside a minimum net worth.',
    minimum: 'RBC ratio 100%; minimum net worth by the Insurance Code schedule',
    ratio: { label: 'RBC ratio', numerator: 'Available capital', denominator: 'Risk-based capital' },
    ladder: twoBand(100,
      { level: 'RBC ratio met', action: 'No intervention.' },
      { level: 'Below 100%', action: 'The IC requires a capital build-up plan and may restrict business.' }),
  }),
  margin('VN', 'Vietnam', 'Insurance Supervisory Authority, Ministry of Finance',
    'A solvency margin of the greater of a share of retained premiums and a share of claims, which the margin of solvency must cover, plus a minimum charter capital by class. The 2022 Law on Insurance Business moves to risk-based capital by 2028.',
    { transition: 'Risk-based capital by 2028' }),

  // ── South Asia ──
  {
    code: 'IN',
    country: 'India',
    regime: 'Required Solvency Margin',
    family: 'solvency_margin',
    style: 'factor',
    regulator: 'Insurance Regulatory and Development Authority of India (IRDAI)',
    requirement: 'The solvency ratio is available solvency margin over required solvency margin, the RSM factor-based on net premium and net incurred claims by line. A control level of 150%. IRDAI is moving to a risk-based capital regime.',
    minimum: 'Solvency ratio 150%',
    ratio: { label: 'Solvency ratio', numerator: 'Available solvency margin', denominator: 'Required solvency margin' },
    calibration: null,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 150 },
    ladder: [
      { min_pct: 150, level: 'Above the control level', tone: 'good', action: 'No intervention.' },
      { min_pct: 100, level: 'Below the 150% control level', tone: 'warn', action: 'IRDAI requires a financial plan and can restrict business.' },
      { min_pct: 0, level: 'Below the required margin itself', tone: 'bad', action: 'Directions to restore solvency; the licence is at risk.' },
    ],
    transition: 'Risk-based capital under development',
  },
  margin('PK', 'Pakistan', 'Securities and Exchange Commission of Pakistan (SECP)',
    'Admissible assets must exceed liabilities by the solvency margin under the Insurance Rules — the greater of fixed minimums and shares of premiums and claims — with minimum paid-up capital PKR 500m for a non-life insurer.'),
  {
    code: 'LK',
    country: 'Sri Lanka',
    regime: 'Risk-Based Capital (2016)',
    family: 'rbc',
    style: 'factor',
    regulator: 'Insurance Regulatory Commission of Sri Lanka (IRCSL)',
    requirement: 'The Capital Adequacy Ratio is total available capital over risk-based capital required — credit, market, liability and operational risk charges. A minimum CAR of 120%, and total available capital of at least LKR 500m.',
    minimum: 'CAR 120%; TAC LKR 500m',
    ratio: { label: 'CAR', numerator: 'Total available capital', denominator: 'Risk-based capital required' },
    calibration: null,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 120 },
    ladder: [
      { min_pct: 120, level: 'Above the 120% minimum', tone: 'good', action: 'No intervention.' },
      { min_pct: 100, level: 'Below the 120% minimum', tone: 'warn', action: 'A corrective plan to the IRCSL.' },
      { min_pct: 0, level: 'Below 100%', tone: 'bad', action: 'Restrictions on business; recapitalisation ordered.' },
    ],
    transition: null,
  },
  margin('BD', 'Bangladesh', 'Insurance Development and Regulatory Authority (IDRA)',
    'A solvency margin under the Insurance Act 2010 rules plus minimum paid-up capital (BDT 400m for a non-life insurer).'),
  minimumCapital('NP', 'Nepal', 'Nepal Insurance Authority',
    'Minimum paid-up capital (NPR 2.5bn for a non-life insurer from 2023) and a solvency margin; risk-based capital in preparation.',
    { transition: 'Risk-based capital in preparation' }),

  // ── Gulf and Levant ──
  {
    code: 'AE',
    country: 'United Arab Emirates',
    regime: 'Solvency II-type Financial Regulations',
    family: 'solvency_ii',
    style: 'economic',
    regulator: 'Central Bank of the UAE (CBUAE)',
    requirement: 'A Solvency Capital Requirement at the 99.5% one-year value at risk by a Solvency II-type standard formula, a Minimum Capital Requirement, and a Minimum Guarantee Fund of the higher of a fixed sum and a third of the SCR. Own funds are read over the SCR.',
    minimum: 'MCR AED 100m; Minimum Guarantee Fund the higher of a fixed sum and one third of the SCR',
    ratio: { label: 'SCR ratio', numerator: 'Own funds', denominator: 'SCR' },
    calibration: VAR995,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 100 },
    ladder: [
      { min_pct: 100, level: 'SCR met', tone: 'good', action: 'No regulatory action.' },
      { min_pct: 33, level: 'Below the SCR', tone: 'warn', action: 'A recovery plan to the Central Bank within the period it sets.' },
      { min_pct: 0, level: 'Below the Minimum Guarantee Fund', tone: 'bad', action: 'Stricter measures, up to withdrawal of the licence.' },
    ],
    transition: null,
  },
  margin('SA', 'Saudi Arabia', 'Insurance Authority (formerly SAMA)',
    'A solvency margin of the higher of the premium and claims methods under the Implementing Regulations, with a minimum capital of SAR 100m (SAR 200m with reinsurance); a risk-based framework is under development.',
    { transition: 'Risk-based capital under development' }),
  margin('KW', 'Kuwait', 'Insurance Regulatory Unit (IRU)',
    'Law 125 of 2019: minimum capital and a solvency margin on premiums and claims.'),
  margin('BH', 'Bahrain', 'Central Bank of Bahrain (CBB)',
    'CBB Rulebook Volume 3: capital available must exceed the required solvency margin (premium and claims methods), and never less than the minimum fund.'),
  margin('OM', 'Oman', 'Financial Services Authority (FSA)',
    'A solvency margin on premiums and claims plus minimum capital of OMR 10m.'),
  rbc('QA', 'Qatar', 'Qatar Central Bank (QCB); QFCRA within the Qatar Financial Centre', {
    regime: 'Risk-based solvency (QCB instructions)',
    requirement: 'Required capital from insurance, market, credit and operational risk charges, which eligible capital must cover with a supervisory buffer. Firms in the Qatar Financial Centre follow the QFCRA PINS rules, a Solvency II-type framework.',
    ratio: { label: 'Solvency ratio', numerator: 'Eligible capital', denominator: 'Required capital' },
    ladder: twoBand(100,
      { level: 'Requirement met', action: 'No intervention.' },
      { level: 'Requirement not met', action: 'A capital plan to the regulator; restrictions on business.' }),
  }),
  margin('JO', 'Jordan', 'Central Bank of Jordan',
    'Solvency margin instructions on premiums and claims plus minimum capital, supervised by the Central Bank since 2021.'),
  margin('LB', 'Lebanon', 'Insurance Control Commission (ICC)',
    'Minimum capital plus a solvency margin on premiums and claims.'),
  minimumCapital('IQ', 'Iraq', 'Iraqi Insurance Diwan',
    'Minimum paid-up capital under the Insurance Business Regulation Act 2005.'),
  minimumCapital('SY', 'Syria', 'Syrian Insurance Supervisory Commission',
    'Minimum paid-up capital by class of business.'),
  margin('PS', 'Palestine', 'Palestine Capital Market Authority (PCMA)',
    'Minimum capital and a solvency margin on premiums and claims.'),

  // ── North Africa ──
  margin('EG', 'Egypt', 'Financial Regulatory Authority (FRA)',
    'A solvency margin on premiums and claims, with minimum capital raised under the Unified Insurance Law 155 of 2024 and a move toward risk-based supervision.',
    { transition: 'Risk-based supervision under the 2024 law' }),
  margin('MA', 'Morocco', 'Autorité de Contrôle des Assurances et de la Prévoyance Sociale (ACAPS)',
    'A Solvency I-style margin today; ACAPS\'s Solvabilité Basée sur les Risques (SBR), a three-pillar Solvency II-type regime, is being phased in.',
    { transition: 'SBR (risk-based solvency) phasing in' }),
  margin('TN', 'Tunisia', 'Comité Général des Assurances (CGA)',
    'A solvency margin on premiums and claims plus minimum capital.'),
  margin('DZ', 'Algeria', 'Commission de Supervision des Assurances, Ministry of Finance',
    'Minimum capital plus a solvency margin on premiums, claims and technical reserves.'),
  minimumCapital('LY', 'Libya', 'Libyan Insurance Supervisory Authority',
    'Minimum paid-up capital by class of business.'),
  minimumCapital('SD', 'Sudan', 'Insurance Supervisory Authority',
    'Minimum paid-up capital by class of business.'),

  // ── Sub-Saharan Africa ──
  {
    code: 'ZA',
    country: 'South Africa',
    regime: 'Solvency Assessment and Management (SAM)',
    family: 'solvency_ii',
    style: 'economic',
    regulator: 'Prudential Authority (South African Reserve Bank)',
    requirement: 'A Solvency Capital Requirement at the 99.5% one-year value at risk by the standard formula or an approved internal model, and a Minimum Capital Requirement between 25% and 45% of the SCR with an absolute floor (R15m for a non-life insurer). Solvency II adapted for South Africa.',
    minimum: 'MCR: 25%–45% of the SCR; absolute floor R15m',
    ratio: { label: 'SCR cover ratio', numerator: 'Eligible own funds', denominator: 'SCR' },
    calibration: VAR995,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 100 },
    ladder: S2_LADDER,
    transition: null,
  },
  margin('NG', 'Nigeria', 'National Insurance Commission (NAICOM)',
    'Minimum paid-up capital, re-set upward by the Nigerian Insurance Industry Reform Act 2025, plus a solvency margin of the higher of 15% of net premium income and the minimum capital. NAICOM\'s risk-based capital framework is being phased in.',
    { transition: 'Risk-based capital phasing in under the 2025 Act' }),
  {
    code: 'KE',
    country: 'Kenya',
    regime: 'Risk-Based Capital',
    family: 'rbc',
    style: 'factor',
    regulator: 'Insurance Regulatory Authority (IRA)',
    requirement: 'The Capital Adequacy Ratio is total capital available over total capital required — insurance, market, credit and operational risk charges — with 200% required after the 2017–2020 phase-in. Minimum capital the higher of KES 600m and 20% of net earned premium for a general insurer.',
    minimum: 'CAR 200%; minimum capital the higher of KES 600m and 20% of net earned premium',
    ratio: { label: 'CAR', numerator: 'Total capital available', denominator: 'Total capital required' },
    calibration: null,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 200 },
    ladder: [
      { min_pct: 200, level: 'Above the 200% requirement', tone: 'good', action: 'No intervention.' },
      { min_pct: 100, level: 'Below 200%', tone: 'warn', action: 'A capital restoration plan to the IRA.' },
      { min_pct: 0, level: 'Below 100%', tone: 'bad', action: 'Restrictions on business; recapitalisation ordered.' },
    ],
    transition: null,
  },
  {
    code: 'GH',
    country: 'Ghana',
    regime: 'Risk-based capital (Insurance Act 2021)',
    family: 'rbc',
    style: 'factor',
    regulator: 'National Insurance Commission (NIC)',
    requirement: 'Minimum capital of GHS 50m for an insurer and GHS 125m for a reinsurer, plus a risk-based Capital Adequacy Ratio of at least 150%.',
    minimum: 'CAR 150%; minimum capital GHS 50m (insurer), GHS 125m (reinsurer)',
    ratio: { label: 'CAR', numerator: 'Available capital', denominator: 'Required capital' },
    calibration: null,
    proxy: { measure: 'var', confidence: 99.5, at_pct: 150 },
    ladder: [
      { min_pct: 150, level: 'Above the 150% requirement', tone: 'good', action: 'No intervention.' },
      { min_pct: 100, level: 'Below 150%', tone: 'warn', action: 'A capital plan to the NIC.' },
      { min_pct: 0, level: 'Below 100%', tone: 'bad', action: 'Restrictions on business; recapitalisation ordered.' },
    ],
    transition: null,
  },
  minimumCapital('ET', 'Ethiopia', 'National Bank of Ethiopia (NBE)',
    'A National Bank of Ethiopia minimum paid-up capital directive plus a solvency margin directive.'),
  minimumCapital('TZ', 'Tanzania', 'Tanzania Insurance Regulatory Authority (TIRA)',
    'Minimum paid-up capital and a solvency margin under the Insurance Act 2009; risk-based supervision in development.',
    { transition: 'Risk-based supervision in development' }),
  margin('UG', 'Uganda', 'Insurance Regulatory Authority of Uganda (IRA)',
    'Minimum paid-up capital and a solvency margin under the Insurance Act 2017; a risk-based capital framework has been developed.',
    { transition: 'Risk-based capital framework developed' }),
  minimumCapital('ZW', 'Zimbabwe', 'Insurance and Pensions Commission (IPEC)',
    'A minimum capital requirement set in US dollars by IPEC, revised upward in recent reviews, plus a solvency margin. The Zimbabwe Integrated Capital and Risk Programme (ZICARP), a risk-based framework, is being phased in.',
    { transition: 'ZICARP (risk-based capital) phasing in' }),
  minimumCapital('ZM', 'Zambia', 'Pensions and Insurance Authority (PIA)',
    'Minimum capital and a solvency margin under the Insurance Act 2021; risk-based capital in development.',
    { transition: 'Risk-based capital in development' }),
  margin('MZ', 'Mozambique', 'Instituto de Supervisão de Seguros de Moçambique (ISSM)',
    'Minimum capital plus a Solvency I-style margin on premiums and claims.'),
  margin('AO', 'Angola', 'Agência Angolana de Regulação e Supervisão de Seguros (ARSEG)',
    'Minimum capital plus a Solvency I-style margin on premiums and claims.'),
];

const BY_CODE = new Map(REGIMES.map((r) => [r.code, r]));

/** Other spellings a country of domicile is stored under. */
const ALIASES = {
  UK: 'GB', 'GREAT BRITAIN': 'GB', ENGLAND: 'GB', USA: 'US', 'UNITED STATES OF AMERICA': 'US',
  UAE: 'AE', EMIRATES: 'AE', KOREA: 'KR', 'REPUBLIC OF KOREA': 'KR', HOLLAND: 'NL', 'THE NETHERLANDS': 'NL',
  'HONG KONG SAR': 'HK', 'PRC': 'CN', "PEOPLE'S REPUBLIC OF CHINA": 'CN',
  'KSA': 'SA', 'SAUDI': 'SA', 'VIET NAM': 'VN', 'TAIWAN, PROVINCE OF CHINA': 'TW',
};

/** The country code a stored domicile (code, name or alias) refers to, or null. */
export function domicileCode(domicile) {
  if (domicile == null) return null;
  const d = String(domicile).trim();
  if (!d) return null;
  const upper = d.toUpperCase();
  if (BY_CODE.has(upper)) return upper;
  if (upper in ALIASES) return ALIASES[upper];
  const byName = REGIMES.find((r) => r.country.toUpperCase() === upper);
  return byName ? byName.code : null;
}

/** The full regime record for a country code (or a stored domicile), or null. */
export function regimeFor(domicile) {
  const code = domicileCode(domicile);
  if (!code) return null;
  const r = BY_CODE.get(code);
  if (!r) return null;
  return {
    ...r,
    family_label: REGIME_FAMILIES[r.family].label,
    style_label: REGIME_STYLES[r.style],
    as_at: AS_AT,
  };
}

/** The picker's rows: every country, alphabetically, with the regime in a word. */
export function listRegimes() {
  return [...REGIMES]
    .sort((a, b) => a.country.localeCompare(b.country))
    .map((r) => ({
      code: r.code,
      country: r.country,
      regime: r.regime,
      family: r.family,
      family_label: REGIME_FAMILIES[r.family].label,
      style: r.style,
      regulator: r.regulator,
      transition: r.transition,
    }));
}

/** The ladder band a ratio falls in (bands are top-down; the last catches everything). */
export function bandOf(ladder, ratioPct) {
  if (ratioPct == null || !Number.isFinite(ratioPct)) return null;
  return ladder.find((b) => ratioPct >= b.min_pct) || ladder[ladder.length - 1];
}

/** The ratio below which the regulator first acts: the top band's floor. */
export const interventionPct = (regime) => regime.ladder[0].min_pct;

/** The lowest rung with a positive floor — below it the regulator takes control. */
export function controlPct(regime) {
  const floors = regime.ladder.map((b) => b.min_pct).filter((v) => v > 0);
  return floors.length ? Math.min(...floors) : null;
}

/**
 * Where an insurer stands on a regime's ladder.
 *
 * @param {object} regime           a record from regimeFor()
 * @param {object} p
 * @param {number} p.available      the capital held (own funds / TAC / capital available)
 * @param {number} [p.modelled]     the DFA's modelled capital at the regime's proxy
 *                                  calibration (VaR or TVaR at its confidence)
 * @param {number} [p.given]        the regulatory requirement itself, when known
 *                                  (the SCR, the ACL, the minimum capital…)
 * @returns the requirement used and where it came from, the ratio, the band,
 *          the first action level, and the strain the insurer can take before
 *          reaching it and before reaching the control level — the handbook's
 *          "maximum withstandable strain"
 */
export function assessCapitalPosition(regime, { available, modelled = null, given = null }) {
  if (!regime) return null;
  const round2 = (n) => Math.round(n * 100) / 100;
  let required = Number(given) > 0 ? Number(given) : null;
  let source = required != null ? 'given' : null;
  if (required == null && regime.proxy && Number(modelled) > 0) {
    required = Number(modelled) * 100 / regime.proxy.at_pct;
    source = 'modelled';
  }
  const intervention = interventionPct(regime);
  const control = controlPct(regime);
  if (!(required > 0)) {
    return {
      required: null,
      required_source: null,
      ratio_pct: null,
      band: null,
      intervention_pct: intervention,
      control_pct: control,
      strain_before_action: null,
      strain_before_control: null,
      needs_input: true,
    };
  }
  const ratio = (Number(available) / required) * 100;
  const band = bandOf(regime.ladder, ratio);
  return {
    required: round2(required),
    required_source: source,
    ratio_pct: round2(ratio),
    band: { level: band.level, tone: band.tone, action: band.action, min_pct: band.min_pct },
    intervention_pct: intervention,
    control_pct: control,
    // The loss that would take the ratio down to the first action level and
    // to the control level: negative means the insurer is already below it.
    strain_before_action: round2(Number(available) - required * (intervention / 100)),
    strain_before_control: control != null ? round2(Number(available) - required * (control / 100)) : null,
    needs_input: false,
  };
}
