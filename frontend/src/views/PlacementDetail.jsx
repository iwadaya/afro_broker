import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Card, useFetch, Form, StatusPill, ErrorBanner, Money, Pct, Uuid, fmtDate } from '../components.jsx';
import WizardNav from '../WizardNav.jsx';
import { useAuth, useHasRole } from '../auth.jsx';
import { Fr, DateField, CobModal, EXP_YEARS, addMonths12, basisForTreatyType } from './treatyDetail.jsx';
import { useRefData, entryOf, labelOf, selectValueOf, OffListOption, RefOptions } from '../RefData.jsx';
import {
  countryOfDomicile, domicileMatches, treatyTypeOf, layerTypeOf, parseClass, CATEGORY_LABELS,
} from '../refData.js';
import {
  StructCard, layerToRow, rowToPayload, emptyLayerRow, emptyPropTerms, emptyStructure,
  stopLossFieldsOf, withStopLossAmounts, applyCoverMode, npCoverMode,
  seedCobRows, cobRowsToPayload, cobRowsFromPayload,
  ExpiringStructureSection, BasisPills, emptyExpiring, emptyNpTerms, expiringToPayload, expiringFromPayload,
  ComplementaryCoverModal, complementaryLabel, hasComplementary, emptyComplementary,
  expiringIsStored, basisLayerCount, hasNP, hasProp, copyExpiringToStructures,
  QuoteStructureSection, resizeStructures, structuresToPayload, structuresFromPayload, propCalcs,
  RetentionsTable, seedRetentions, retentionsToPayload, retentionsFromPayload, emptyRetentionRow,
} from '../StructureSections.jsx';
import PlacementData from '../PlacementData.jsx';
import RenewalPackApproval from '../RenewalPackApproval.jsx';
import RenewalPack from '../RenewalPack.jsx';
import Negotiation from '../Negotiation.jsx';
import FinalPlacement from '../FinalPlacement.jsx';
import ModellingPane, {
  ModellingProvider, isModellingTab, modellingBases, primaryBasis, modellingGroups,
} from '../modelling/index.jsx';

// Mirrors backend statusMachine forward edges so the UI offers valid next steps.
const FORWARD = {
  DRAFT: ['DATA'], DATA: ['PACK'], PACK: ['LEAD_MARKETING'],
  LEAD_MARKETING: ['QUOTED'], QUOTED: ['FOT_AGREED'],
  // FOT_AGREED onward is driven by FOT/lines actions on the layer.
  INCOMPLETE: ['FOLLOW_MARKETING'],
};
const TERMINALS = ['DECLINED', 'NTU', 'LAPSED'];
/** The stages that open only once a renewal pack version is approved. */
const LOCKED_TABS = ['negotiation', 'finalquote', 'final'];
const ACTIVE = ['DRAFT', 'DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED', 'FOT_AGREED', 'FOLLOW_MARKETING', 'LINES_WRITTEN', 'INCOMPLETE'];

/** The cedant dropdown's "register a new cedant" choice. */
const NEW_CEDANT = '__new__';

/** The placement behind /placements/new: nothing stored yet, a DRAFT held in
    memory until Create Placement runs the whole chain against the API. */
const NEW_PLACEMENT = {
  id: null, reference: 'New placement', status: 'DRAFT', layers: [], quote_structures: [],
  structure_cobs: {}, retentions: null, expiring_structure: null, class: '', currency: 'USD',
  notes: '', renewal_of: null,
};

/** Pull the broker / experience-start-year facts back out of the notes fold. */
function parseNotes(notes) {
  const out = { broker: '', expStartYear: '', rest: [] };
  for (const part of (notes || '').split(' · ')) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('Broker: ')) out.broker = t.slice(8);
    else if (/^Experience from \d{4}$/.test(t)) out.expStartYear = t.slice(-4);
    else out.rest.push(t);
  }
  return { broker: out.broker, expStartYear: out.expStartYear, rest: out.rest.join(' · ') };
}

const realRows = (rows) => (rows || []).filter((r) => r.name || r.limit || r.attachment || r.premium);

/** A section that needs the placement to exist — shown in its place on a
    placement that is still being set up. */
/**
 * The cedant's uploaded renewal pack, on the placement it belongs to.
 *
 * One line rather than a panel: the analysis itself is the place to read it,
 * and the pack builder is where its section coverage is used. When nothing is
 * linked the line still shows, because a broker looking for the submission
 * needs to be told there isn't one and where to attach it.
 */
function LinkedUpload({ uploads }) {
  if (!uploads) return null; // still loading — say nothing rather than "none"
  const up = uploads.find((u) => u.status === 'complete') || uploads[0];

  if (!up) {
    return (
      <div className="td-upload">
        <span className="td-contract-label">Uploaded pack:</span>
        <span>
          none linked — upload the cedant's submission under{' '}
          <Link to="/renewal-packs">Renewal packs</Link> and link it to this placement.
        </span>
      </div>
    );
  }

  const analysed = up.status === 'complete' && up.sections_total > 0;
  return (
    <div className="td-upload">
      <span className="td-contract-label">Uploaded pack:</span>
      <span>
        <Link to={`/renewal-packs/${up.id}`}>{up.cedant_name}</Link>
        {' · '}{up.doc_count} {up.doc_count === 1 ? 'file' : 'files'}
        {analysed
          ? <> · <b>{up.sections_supplied} of {up.sections_total}</b> sections supplied · analysed {fmtDate(up.analysed_at)}</>
          : <> · <StatusPill value={up.status} /></>}
      </span>
    </div>
  );
}

/** The Quoting Stage (and what follows it) before any renewal pack version has been approved. */
function NegotiationLocked({ packs, onOpenPack }) {
  const versions = packs.data || [];
  const latest = versions[0];
  const submitted = versions.find((pk) => pk.status === 'submitted');
  const state = packs.loading && !packs.data
    ? 'Checking the renewal pack…'
    : !latest
      ? 'No renewal pack has been created yet. Create one on the Renewal Pack tab, submit it on the Pack Approval tab, and a Senior Broker approves it there.'
      : submitted
        ? `Renewal pack v${submitted.version} is awaiting a Senior Broker's approval on the Pack Approval tab.`
        : `Renewal pack v${latest.version} is a draft${latest.rejection_note ? ' — it was returned with a note' : ''}. Submit it for a Senior Broker's approval on the Pack Approval tab.`;
  return (
    <div className="td-card" data-testid="negotiation-locked">
      <div className="td-card-head">
        <span className="td-card-label">QUOTING STAGE LOCKED</span>
        <span className="td-card-tag">🔒 AWAITING PACK APPROVAL</span>
      </div>
      <div className="td-card-body">
        <div className="td-hint">
          The quoting stage, the final quote and the final placement open once a renewal pack version has been approved by a Senior Broker. {state}
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="np-struct-btn np-struct-btn--accent" onClick={onOpenPack}>Open the Pack Approval tab</button>
        </div>
      </div>
    </div>
  );
}

function CreateFirst({ what }) {
  return (
    <div className="td-card">
      <div className="td-card-head">
        <span className="td-card-label">CREATE THE PLACEMENT FIRST</span>
        <span className="td-card-tag">PENDING</span>
      </div>
      <div className="td-card-body">
        <div className="td-hint">
          {what} once the placement is created — use <b>Create Placement</b> in the dock
          when the Treaty Detail is complete. The sections before it (treaty detail,
          expiring structure, structures to quote and retentions) are kept and saved
          with it.
        </div>
      </div>
    </div>
  );
}

/**
 * The placement page — every section of a placement in one tabbed screen:
 * the Treaty Detail, the expiring structure, the structures to quote, the
 * retentions, the Universe modelling workflow, the data screen (the screens
 * read as one and compared with the expiring year), the renewal pack and its
 * approval, the quoting stage, the final quote and the final placement.
 * /placements/new is this same screen for a placement that does not exist
 * yet: the treaty detail, expiring structure, structures and retentions are
 * held in memory and written in one chain by Create Placement, which then
 * lands on the placement's own URL.
 */
export default function PlacementDetail() {
  const { id: routeId } = useParams();
  const isNew = routeId === 'new';
  const id = isNew ? null : routeId;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const canEdit = useHasRole('broker', 'admin');
  // Releasing a submission to market is the second pair of eyes, never the
  // broker who drafted it.
  const canRelease = useHasRole('underwriter', 'admin');
  // A renewal pack is approved by a Senior Broker; that approval opens the
  // negotiation.
  const canApprove = useHasRole('senior_broker', 'admin');
  // Underwriters cannot edit the placement but may run the analysis.
  const canAnalyse = useHasRole('broker', 'admin', 'underwriter');
  const placement = useFetch('GET', id ? `/placements/${id}` : null, [id]);
  // The pack versions, for the lock on the Negotiation tab: it opens once a
  // version has been approved by a Senior Broker.
  const packList = useFetch('GET', id && !isNew ? `/placements/${id}/packs` : null, [id]);
  const packApproved = !!packList.data?.some((pk) => pk.status === 'approved');
  const negotiationLocked = !isNew && !packApproved;
  // The register, for the treaty detail's country / cedant dropdowns.
  const cedantList = useFetch('GET', '/cedants?limit=500', []);
  // The placements a new one can renew (the "Renewal of" dropdown).
  const sourceList = useFetch('GET', isNew ? '/placements?limit=200' : null, [isNew]);
  // The Universe lookups the dropdowns bind to (country, treaty type, class
  // of business, broker, currency), by row id.
  const ref = useRefData();
  // The cedant's own submission, when one has been uploaded and linked to
  // this placement. Its section coverage is what the pack builder follows.
  const uploads = useFetch('GET', id && !isNew ? `/renewal-analyses?placement_id=${id}` : null, [id, isNew]);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('detail');
  const [ed, setEd] = useState(null);
  const [ced, setCed] = useState(null);
  const [showCob, setShowCob] = useState(false);
  // Setting up a new placement: the creation chain in flight, the placement
  // being renewed, and whether the expiring basis has been chosen by hand
  // (until then it follows the treaty type).
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('');
  const [sourceInfo, setSourceInfo] = useState(null);
  const [expiringTouched, setExpiringTouched] = useState(false);

  // What the treaty-detail picks read as — the lookup row's name or code, or
  // the stored text itself when the lookups do not carry it. The placement
  // stores the class string, the currency code and the broker's name.
  const treatyTypeRow = entryOf(ref.treatyTypes, ed?.treatyTypeId);
  const treatyTypeName = ed ? labelOf(ref.treatyTypes, ed.treatyTypeId) : '';
  const cobNames = (ed?.classIds || []).map((c) => labelOf(ref.classes, c));
  const cobKey = cobNames.join('|');
  const brokerName = ed ? labelOf(ref.brokers, ed.brokerId) : '';
  const currencyCode = ed ? labelOf(ref.currencies, ed.currencyId, 'code') : '';
  const classString = `${cobNames.join(' / ')} ${treatyTypeName}`.trim();

  const pd = isNew ? NEW_PLACEMENT : placement.data;
  // Hydrate the editable treaty-detail form from the loaded placement: the
  // stored class, currency and broker resolve to their lookup rows.
  useEffect(() => {
    if (!pd) return;
    const cls = parseClass(pd.class, ref.treatyTypes);
    const n = parseNotes(pd.notes);
    setEd({
      treatyTypeId: treatyTypeOf(cls.treatyType, ref.treatyTypes)?.id || cls.treatyType,
      classIds: cls.cobs.map((c) => entryOf(ref.classes, c)?.id || c),
      brokerId: entryOf(ref.brokers, n.broker)?.id || n.broker,
      expStartYear: n.expStartYear,
      notes: n.rest,
      currencyId: entryOf(ref.currencies, pd.currency || 'USD')?.id || pd.currency || 'USD',
      inception: pd.inception?.slice(0, 10) || '',
      renewal: pd.expiry?.slice(0, 10) || '',
      // A new placement's renewal date tracks inception + 12 months until
      // edited (the Universe auto-calc); a saved one keeps its date.
      renewalManual: !isNew,
      // Country is left blank until edited — the cedant's domicile shows
      // through — so a reload never drops a saved cedant.
      countryId: '',
      cedantId: pd.cedant_id || '',
      // Registering a cedant from the dropdown.
      cedantName: '', contactName: '', contactEmail: '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pd?.id, pd?.updated_at, ref.ready]);
  useEffect(() => {
    if (!pd?.cedant_id) return;
    api('GET', `/cedants/${pd.cedant_id}`).then(setCed).catch(() => {});
  }, [pd?.cedant_id]);
  // Universe auto-calc: a new placement's renewal date = inception + 12 months.
  useEffect(() => {
    if (!isNew || !ed?.inception || ed.renewalManual) return;
    const auto = addMonths12(ed.inception);
    if (auto && auto !== ed.renewal) setEd((s) => ({ ...s, renewal: auto }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, ed?.inception, ed?.renewalManual]);

  const [structures, setStructures] = useState(null);
  const [retentions, setRetentions] = useState(seedRetentions(null));
  const [expiring, setExpiring] = useState(emptyExpiring());
  // The complementary cover modal (net cover on a proportional expiring
  // treaty, proportional cover on a non-proportional one).
  const [showComp, setShowComp] = useState(false);
  // True while the expiring structure is read from the prior year contract
  // rather than saved on this placement.
  const [expDerived, setExpDerived] = useState(false);
  const [cobsExp, setCobsExp] = useState([]);
  // Hydrate the quote structures from the placement. Structure 1 (when
  // non-proportional) is backed by the placement's real layers.
  useEffect(() => {
    if (!pd?.layers) return;
    if (isNew) {
      setStructures([emptyStructure()]);
      setRetentions(seedRetentions(null));
      setExpiring({ ...emptyExpiring(), layers: [] });
      setExpDerived(false);
      setCobsExp([]);
      return;
    }
    const cobs = parseClass(pd.class, ref.treatyTypes).cobs;
    let list = structuresFromPayload(pd.quote_structures, cobs);
    if (list.length === 0) {
      list = [{
        basis: 'NP',
        layers: pd.layers.map(layerToRow),
        prop: emptyPropTerms(),
        cobs: seedCobRows(cobs, cobRowsFromPayload(pd.structure_cobs?.quote), pd.layers.length),
      }];
    } else if (list[0].basis !== 'PROP') {
      // The real layers back structure 1; their loss-ratio terms (a stop
      // loss) live only on the stored structure, so they ride along by index.
      const stored = list[0].layers || [];
      list[0] = { ...list[0], layers: pd.layers.map((l, i) => ({ ...layerToRow(l), ...stopLossFieldsOf(stored[i]) })) };
    }
    setStructures(list);
    setRetentions(seedRetentions(retentionsFromPayload(pd.retentions)));
    if (expiringIsStored(pd.expiring_structure)) {
      const stored = expiringFromPayload(pd.expiring_structure);
      setExpiring(stored);
      setExpDerived(false);
      setCobsExp(seedCobRows(cobs, cobRowsFromPayload(pd.structure_cobs?.expiring), basisLayerCount(stored)));
    } else if (!pd.renewal_of) {
      setExpiring(emptyExpiring());
      setExpDerived(false);
      setCobsExp(seedCobRows(cobs, cobRowsFromPayload(pd.structure_cobs?.expiring), 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pd]);
  // Nothing stored on a renewal clone → the expiring structure is the prior
  // year contract's, read live so it tracks any change made there.
  useEffect(() => {
    if (!pd?.renewal_of || expiringIsStored(pd.expiring_structure)) return;
    api('GET', `/placements/${pd.renewal_of}`)
      .then((src) => {
        // The expiring basis is one or the other: a prior year with layers
        // reads as non-proportional (a proportional structure alongside them
        // is still carried, and shows if the basis is switched), a prop-only
        // prior year as proportional.
        const propStruct = (src.quote_structures || []).find((st) => st.basis === 'PROP');
        const rows = (src.layers || []).map(layerToRow);
        const basis = rows.length || !propStruct ? 'NP' : 'PROP';
        setExpiring((s) => ({
          basis,
          layers: rows.length ? rows : [emptyLayerRow()],
          prop: { ...emptyPropTerms(), ...(propStruct?.prop || {}) },
          complementary: s.complementary || emptyComplementary(),
        }));
        setExpDerived(true);
        setCobsExp(seedCobRows(parseClass(pd.class, ref.treatyTypes).cobs, cobRowsFromPayload(pd.structure_cobs?.expiring), hasNP(basis) ? rows.length : 0));
      })
      .catch(() => { setExpiring(emptyExpiring()); setExpDerived(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pd?.renewal_of]);

  // A new placement's COB limit rows track the Treaty Detail classes and the
  // expiring layer count.
  const expLayerCount = basisLayerCount(expiring);
  useEffect(() => {
    if (!isNew || !ed) return;
    setCobsExp((prev) => seedCobRows(cobNames, prev, expLayerCount));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, cobKey, expLayerCount]);

  // The expiring basis of a new placement defaults from the treaty type's
  // category (proportional / non-proportional) until it is picked by hand or
  // a renewal source loads.
  useEffect(() => {
    if (!isNew || expiringTouched) return;
    const auto = basisForTreatyType(treatyTypeRow);
    if (auto) setExpiring((s) => (s.basis === auto ? s : { ...s, basis: auto }));
  }, [isNew, treatyTypeRow, expiringTouched]);
  // The expiring structure's non-proportional treaty type is picked from the
  // Treaty Detail's non-proportional types, and defaults to the Treaty
  // Detail's own type while it is one of them and none has been picked.
  const npTreatyTypes = useMemo(
    () => (ref.treatyTypes || []).filter((t) => t.category === 'NON_PROPORTIONAL').map((t) => t.name),
    [ref.treatyTypes],
  );
  // Likewise the proportional treaty type — the expiring structure's and each
  // structure to quote's — is picked from the Treaty Detail's proportional
  // types and defaults to the Treaty Detail's own while it is one of them.
  const propTreatyTypes = useMemo(
    () => (ref.treatyTypes || []).filter((t) => t.category === 'PROPORTIONAL').map((t) => t.name),
    [ref.treatyTypes],
  );
  const propDefault = treatyTypeRow?.category === 'PROPORTIONAL' ? treatyTypeRow.name : '';
  const expPropType = expiring.prop?.treatyType || '';
  const structuresNeedType = (structures || []).some((st) => !st.prop?.treatyType);
  useEffect(() => {
    if (!propDefault) return;
    if (!expPropType) setExpiring((s) => ({ ...s, prop: { ...emptyPropTerms(), ...(s.prop || {}), treatyType: propDefault } }));
    if (structuresNeedType) {
      setStructures((list) => (list || []).map((st) => (st.prop?.treatyType
        ? st
        : { ...st, prop: { ...emptyPropTerms(), ...(st.prop || {}), treatyType: propDefault } })));
    }
  }, [propDefault, expPropType, structuresNeedType]);
  const npDefault = treatyTypeRow?.category === 'NON_PROPORTIONAL' ? treatyTypeRow.name : '';
  const npPicked = expiring.np?.treatyType || '';
  const structuresNeedNpType = (structures || []).some((st) => st.basis !== 'PROP' && !st.npTreatyType);
  useEffect(() => {
    if (!npDefault) return;
    if (!npPicked) setExpiring((s) => ({ ...s, np: { ...emptyNpTerms(), ...(s.np || {}), treatyType: npDefault } }));
    if (structuresNeedNpType) {
      setStructures((list) => (list || []).map((st) => (st.basis === 'PROP' || st.npTreatyType
        ? st
        : { ...st, npTreatyType: npDefault, layers: applyCoverMode(st.layers, npCoverMode(npDefault)) })));
    }
  }, [npDefault, npPicked, structuresNeedNpType]);
  const pickExpiringBasis = (basis) => {
    setExpiringTouched(true);
    setExpiring((s) => ({ ...s, basis }));
  };

  // Arriving from the register's Renew Placement wizard (?source=…):
  // preselect the expiring placement so the whole form auto-populates.
  const sourceParam = params.get('source') || '';
  useEffect(() => {
    if (isNew && sourceParam) pickSource(sourceParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, sourceParam]);

  // Renewal: picking a source carries its treaty detail over, loads its
  // layers as the expiring structure and, if untouched, seeds structure 1
  // from it (premiums reset) — as in the modelling tool's renew wizard.
  async function pickSource(srcId) {
    setSource(srcId);
    setSourceInfo(null);
    if (!srcId) return;
    try {
      const [p, packs] = await Promise.all([
        api('GET', `/placements/${srcId}`),
        api('GET', `/placements/${srcId}/packs`),
      ]);
      setSourceInfo({ placement: p, packs });
      // The renewal incepts when the source expires; the renewal date then
      // auto-tracks inception + 12 months.
      const { cobs, treatyType: typeName } = parseClass(p.class, ref.treatyTypes);
      setEd((s) => ({
        ...(s || {}),
        cedantId: p.cedant_id,
        countryId: '',
        classIds: cobs.map((c) => entryOf(ref.classes, c)?.id || c),
        treatyTypeId: treatyTypeOf(typeName, ref.treatyTypes)?.id || typeName || '',
        currencyId: entryOf(ref.currencies, p.currency || 'USD')?.id || p.currency || 'USD',
        inception: String(p.expiry).slice(0, 10),
        renewalManual: false,
      }));
      api('GET', `/cedants/${p.cedant_id}`).then(setCed).catch(() => {});
      // Full row mapping, so reinstatements, EGNPI, rate and AAD come across too.
      const rows = (p.layers || []).map((l) => ({ ...layerToRow(l), id: null }));
      // A source with layers loads as non-proportional (its proportional
      // terms are still carried), a prop-only source as proportional. The
      // source decides, so the treaty-type default stops.
      const srcProp = (p.quote_structures || []).find((st) => st.basis === 'PROP');
      setExpiringTouched(true);
      setExpiring((s) => ({
        basis: rows.length || !srcProp ? 'NP' : 'PROP',
        layers: rows.length ? rows.map((r) => ({ ...emptyLayerRow(), ...r })) : [],
        prop: { ...emptyPropTerms(), ...(srcProp?.prop || {}) },
        complementary: s.complementary || emptyComplementary(),
      }));
      setStructures((list) => {
        const s1 = (list || [])[0];
        const untouched = !s1 || (s1.basis !== 'PROP' && s1.layers.length === 1
          && !s1.layers[0].name && !s1.layers[0].limit && !s1.layers[0].attachment && !s1.layers[0].premium);
        if (!untouched) return list;
        const seeded = { ...(s1 || emptyStructure()), basis: 'NP', layers: rows.map((r) => ({ ...emptyLayerRow(), ...r, premium: '' })) };
        return [seeded, ...(list || []).slice(1)];
      });
    } catch (e) {
      setError(e);
    }
  }

  // ── The modelling workflow, inserted after Retentions ────────────────────
  // The Treaty Detail treaty type decides the basis: QS / Surplus run the
  // proportional screens, XoL / Fac the non-proportional ones — the same
  // split as the Universe modelling tool's PROP and NP wizards. The active
  // modelling screen registers its save() on modSaveRef so leaving a tab
  // flushes unsaved work, as the tool's wizard does on Back/Next.
  const modSaveRef = useRef(null);
  // The structures to quote decide which wizards run: proportional,
  // non-proportional, or both — the Treaty Detail's category until a
  // structure exists.
  const bases = modellingBases(
    (treatyTypeRow || treatyTypeOf(parseClass(pd?.class, ref.treatyTypes).treatyType, ref.treatyTypes))?.category,
    structures,
    npCoverMode,
  );
  const basis = primaryBasis(bases);
  const inceptionYear = Number((ed?.inception || pd?.inception || '').slice(0, 4)) || new Date().getFullYear();
  const expStart = Number(ed?.expStartYear) || inceptionYear - 5;
  const numDevYears = Math.max(1, Math.min(60, inceptionYear - expStart));
  const modMeta = useMemo(() => {
    const years = Array.from({ length: numDevYears }, (_, i) => expStart + i);
    const propStruct = (structures || []).find((s) => s.basis === 'PROP');
    const npStruct = (structures || []).find((s) => s.basis !== 'PROP');
    return {
      basis,
      bases,
      currency: currencyCode || pd?.currency || 'USD',
      canEdit,
      cobs: cobNames.length ? cobNames : parseClass(pd?.class, ref.treatyTypes).cobs,
      country: ced?.domicile || '',
      startYear: expStart,
      inceptionYear,
      numDevYears,
      years,
      // Straight stats / premiums / performance grids include the renewal year.
      statYears: [...years, inceptionYear],
      prop: propStruct?.prop || null,
      // A stop loss reaches the modelling with its resolved amounts.
      layers: (npStruct?.layers || []).map(withStopLossAmounts),
    };
  }, [basis, bases, pd, canEdit, ed, ced, structures, expStart, inceptionYear, numDevYears, ref]);

  // What the page renders against: the saved record, or the draft as the
  // treaty detail describes it so far.
  const p = isNew
    ? {
      ...NEW_PLACEMENT,
      currency: currencyCode || 'USD',
      class: ed ? classString : '',
    }
    : placement.data;
  if (placement.error) return <ErrorBanner error={placement.error} />;
  if (!p) return null;

  // A renewal clone starts from the prior year contract, but the expiring
  // structure stays editable — last year's terms are not always what the
  // clone carries over.
  const expiringReadOnly = !canEdit || busy;

  async function act(fn) {
    setError(null);
    try { await fn(); } catch (e) { setError(e); }
  }

  // Status transitions and clone-for-renewal are deliberately not rendered on
  // the Treaty Detail tab (to be re-homed); the state machine constants above
  // still document the valid moves.
  // Live selections for the treaty detail dropdowns — the edited values win,
  // the loaded cedant shows through until then.
  // The selection is a country lookup row — the loaded cedant's domicile
  // resolves to one through the row's code and name, so "UK" lands on
  // United Kingdom — or a domicile the lookups do not carry.
  const countrySel = ed?.countryId
    || (ced?.domicile ? (countryOfDomicile(ced.domicile, ref.countries)?.id || ced.domicile) : '');
  const country = entryOf(ref.countries, countrySel);
  const countryName = labelOf(ref.countries, countrySel);
  const countryCedants = (cedantList.data || []).filter((c) => (country
    ? domicileMatches(c.domicile, country)
    : (c.domicile || '').toLowerCase() === String(countrySel).toLowerCase()));
  const isNewCedant = ed?.cedantId === NEW_CEDANT;
  const cedName = isNewCedant
    ? (ed.cedantName || '').trim()
    : ((cedantList.data || []).find((c) => c.id === ed?.cedantId)?.name || ced?.name || '');
  const contractDescription = ed
    ? [
      ed.inception ? ed.inception.slice(0, 4) : '',
      cedName, treatyTypeName,
      cobNames.length ? `(${cobNames.join(', ')})` : '',
      countryName,
    ].filter(Boolean).join(' ')
    : '';

  // What Create Placement still needs from the Treaty Detail.
  const missing = new Set(isNew && ed
    ? [
      !countrySel && 'Country',
      (!ed.cedantId || (isNewCedant && !ed.cedantName.trim())) && 'Cedant Name',
      !ed.treatyTypeId && 'Treaty Type',
      ed.classIds.length === 0 && 'Line of Business',
      !ed.currencyId && 'Currency',
      !ed.inception && 'Treaty Inception Date',
      !ed.renewal && 'Treaty Renewal Date',
    ].filter(Boolean)
    : []);
  const detailOk = missing.size === 0;

  /** The cedant to write: the picked one, or the one registered from the dropdown. */
  async function resolveCedantId() {
    if (!isNewCedant) return ed.cedantId || undefined;
    const contacts = (ed.contactName || ed.contactEmail)
      ? [{ name: ed.contactName || undefined, email: ed.contactEmail || undefined }]
      : [];
    const created = await api('POST', '/cedants', {
      name: ed.cedantName.trim(),
      // The register keeps the country's name; the lookups resolve it back.
      domicile: countryName || undefined,
      contacts,
    });
    return created.id;
  }

  /** The notes fold: broker, experience start, the expiring summary, free notes. */
  function buildNotes() {
    const parts = [];
    if (brokerName) parts.push(`Broker: ${brokerName}`);
    if (ed.expStartYear) parts.push(`Experience from ${ed.expStartYear}`);
    if (isNew && !source && hasProp(expiring.basis)) {
      const t = expiring.prop;
      const { capacity } = propCalcs(t);
      const terms = [
        t.treatyType,
        capacity ? `capacity ${capacity.toLocaleString()}` : '',
        t.commissionPct !== '' ? `${t.commissionPct}% commission` : '',
        t.epi !== '' ? `EPI ${Number(t.epi).toLocaleString()}` : '',
      ].filter(Boolean).join(' · ');
      if (terms) parts.push(`Expiring (proportional): ${terms}`);
    }
    if (isNew && !source && hasNP(expiring.basis)) {
      const exp = realRows(expiring.layers)
        .map((r) => [r.name, r.type, r.limit && r.attachment ? `${r.limit} xs ${r.attachment}` : r.limit || '', r.premium ? `@ ${r.premium}` : '']
          .filter(Boolean).join(' '))
        .join('; ');
      if (exp) parts.push(`Expiring: ${exp}`);
    }
    if (ed.notes.trim()) parts.push(ed.notes.trim());
    return parts.join(' · ') || undefined;
  }

  // Same mapping the structure save uses, with the treaty type's layer type
  // as the default — so reinstatements, EGNPI, rate, AAD and the risk/cat
  // flags reach the API on creation too.
  const layerPayload = (r, i) => rowToPayload({ ...r, type: r.type || layerTypeOf(treatyTypeRow) }, i, currencyCode);

  /** Create Placement: the whole chain against the API, then this page on
      the placement's own URL. */
  async function create() {
    if (!isNew || !detailOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const cedantId = await resolveCedantId();
      const cls = classString;
      let placementId;
      if (!source) {
        const created = await api('POST', '/placements', {
          cedant_id: cedantId,
          class: cls,
          inception: ed.inception,
          expiry: ed.renewal,
          currency: currencyCode,
          notes: buildNotes(),
        });
        placementId = created.id;
        const s1 = (structures || [])[0];
        if (s1 && s1.basis !== 'PROP') {
          for (const [i, r] of realRows(s1.layers).entries()) {
            await api('POST', `/placements/${placementId}/layers`, layerPayload(r, i));
          }
        } else if (s1) {
          // Proportional structure 1 → layers carrying its capacity and EPI.
          // A combined QS + Surplus creates one layer per half.
          const { hasQS, hasSurplus, surplusCapacity } = propCalcs(s1.prop);
          const epi = s1.prop.epi === '' ? undefined : Number(s1.prop.epi);
          if (hasQS) {
            await api('POST', `/placements/${placementId}/layers`, {
              name: hasSurplus ? 'Quota Share' : 'Structure 1',
              type: 'QS',
              limit_amt: s1.prop.qsLimit === '' ? undefined : Number(s1.prop.qsLimit),
              order_pct: 100,
              premium100: epi,
              currency: currencyCode,
            });
          }
          if (hasSurplus) {
            await api('POST', `/placements/${placementId}/layers`, {
              name: hasQS ? 'Surplus' : 'Structure 1',
              type: 'Surplus',
              limit_amt: surplusCapacity || undefined,
              order_pct: 100,
              premium100: hasQS ? undefined : epi,
              currency: currencyCode,
            });
          }
        }
        await api('PATCH', `/placements/${placementId}`, {
          structure_cobs: { expiring: cobRowsToPayload(cobsExp) },
          expiring_structure: expiringToPayload(expiring),
          quote_structures: structuresToPayload(structures || []),
          retentions: retentionsToPayload(retentions),
        });
      } else {
        const renewal = await api('POST', `/placements/${source}/renew`, {
          cedant_id: cedantId,
          inception: ed.inception,
          expiry: ed.renewal,
        });
        placementId = renewal.id;
        await api('PATCH', `/placements/${placementId}`, {
          class: cls,
          currency: currencyCode,
          notes: buildNotes(),
          structure_cobs: { expiring: cobRowsToPayload(cobsExp) },
          expiring_structure: expiringToPayload(expiring),
          quote_structures: structuresToPayload(structures || []),
          retentions: retentionsToPayload(retentions),
        });
        // Replace the cloned layers with structure 1's edited layers.
        const s1 = (structures || [])[0];
        const toQuote = s1 && s1.basis !== 'PROP' ? realRows(s1.layers) : [];
        if (toQuote.length > 0) {
          const withLayers = await api('GET', `/placements/${placementId}`);
          for (const l of withLayers.layers || []) {
            await api('DELETE', `/layers/${l.id}`);
          }
          for (const [i, r] of toQuote.entries()) {
            await api('POST', `/placements/${placementId}/layers`, layerPayload(r, i));
          }
        }
      }
      navigate(`/placements/${placementId}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  /** Save the expiring structure (and its COB limits). */
  const saveExpiring = () => act(async () => {
    await api('PATCH', `/placements/${id}`, {
      structure_cobs: { expiring: cobRowsToPayload(cobsExp) },
      expiring_structure: expiringToPayload(expiring),
    });
    placement.reload();
  });

  const NAV_GROUPS = [
    {
      label: 'PLACEMENT',
      tabs: [
        ['detail', 'Treaty Detail'],
        ['expiring', 'Expiring Structure'],
        ['structure', 'Quote Structure'],
        ['retentions', 'Retentions'],
      ],
    },
    // The modelling tool's wizard, grouped as its sidebar groups them.
    ...modellingGroups(bases).map((g) => ({ label: g.label, tabs: g.tabs })),
    {
      label: 'DISTRIBUTION',
      tabs: [
        ['data', 'Data'],
        ['pack', 'Renewal Pack'],
        ['approval', 'Pack Approval'],
        ['negotiation', 'Quoting Stage'],
        ['finalquote', 'Final Quote'],
        ['final', 'Final Placement'],
      ],
    },
  ];
  const TABS = NAV_GROUPS.flatMap((g) => g.tabs.map(([key, label]) => ({ key, label })));
  const tabIdx = TABS.findIndex((t) => t.key === tab);
  // Dock navigation lives at the foot of a long pane — land the next tab at
  // its top rather than mid-scroll. Leaving a modelling screen flushes its
  // unsaved work first (the screen's registered save), exactly as the
  // modelling tool's wizard does on Back/Next; a failed save keeps you there.
  const goTab = async (key) => {
    if (modSaveRef.current) {
      let ok = true;
      try { ok = await modSaveRef.current(); } catch { ok = false; }
      if (ok === false) return;
    }
    setTab(key);
    window.scrollTo(0, 0);
  };

  const latestPack = sourceInfo?.packs?.[0];
  const expiringHint = isNew
    ? (source
      ? '⟳ Auto-populated from the placement being renewed.'
      : 'New business — enter last year’s market terms on the basis chosen above, for year-on-year comparison in the renewal pack.')
    : (p.renewal_of
      ? (expDerived
        ? '⟳ Auto-populated from the prior year contract.'
        : 'Recorded for this renewal.')
      : 'New business — last year’s market terms on the basis chosen above. This year’s structure becomes next year’s expiring.');
  const expiringNotice = isNew
    ? (source
      ? '⟳ Expiring structure auto-loaded from the placement being renewed. Change the basis above or edit the terms if last year’s contract differed.'
      : null)
    : (expDerived
      ? '⟳ Expiring structure auto-loaded from the prior year contract. Change the basis above or edit the terms if the expiring contract differed — saving keeps your version.'
      : null);

  return (
    <ModellingProvider placementId={id} meta={modMeta} saveRef={modSaveRef}>
      {/* Frozen header: the way back to the placement home page stays pinned
          under the topbar while the tabs scroll. */}
      <div className="placement-head">
        <div className="breadcrumb"><Link to="/placements">Placements</Link> / {p.reference}</div>
        <div className="card-head">
          <div className="toolbar">
            <button className="small secondary" onClick={() => navigate('/placements')}>
              ← Back to placements
            </button>
            <h1 style={{ margin: 0 }}>{p.reference}</h1>
            {isNew && sourceInfo && (
              <span className="crumb-text">RENEWAL OF {sourceInfo.placement.reference}</span>
            )}
          </div>
          <StatusPill value={p.status} />
        </div>
      </div>

      <div className="wiz">
        <nav className="wizard-tabs" aria-label="Placement sections">
          {NAV_GROUPS.map((g) => (
            <React.Fragment key={g.label}>
              <div className="wizard-tab-group-label">{g.label}</div>
              {g.tabs.map(([key, label]) => {
                const i = TABS.findIndex((t) => t.key === key);
                const locked = LOCKED_TABS.includes(key) && negotiationLocked;
                return (
                  <button key={key} type="button" data-tab={key}
                    className={`wizard-tab${key === tab ? ' wizard-tab--active' : ''}${locked ? ' wizard-tab--locked' : ''}`}
                    aria-current={key === tab ? 'step' : undefined}
                    title={locked ? 'Locked until a renewal pack version is approved by a Senior Broker on the Pack Approval tab' : undefined}
                    onClick={() => goTab(key)}>
                    <span className="wizard-tab-num">{i + 1}</span> {label}
                    {locked && <span className="wizard-tab-lock" aria-label="locked">🔒</span>}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </nav>

        <div className="wiz-main">
          <div className="wiz-content">
            {tab === 'detail' && ed && (
      <>
        <div className="td-summary">
          Cedant: <b>{cedName || '—'}</b> · Country: <b>{countryName || '—'}</b> ·
          Broker: <b>{brokerName || '—'}</b> · Currency: <b>{currencyCode || '—'}</b> ·
          Treaty Type: <b>{treatyTypeName || '—'}</b>
          {cobNames.length > 0 && <> · COB: <b>{cobNames.join(', ')}</b></>}
          {p.renewal_of && (
            <> · <Link to={`/placements/${p.renewal_of}`} data-testid="renewal-of-link">
              Renewal of {p.renewal_of_placement?.reference || 'prior year'}
            </Link></>
          )}
          {(p.renewed_by || []).map((n) => (
            <React.Fragment key={n.id}> · <Link to={`/placements/${n.id}`} data-testid="renewed-by-link">Renewed by {n.reference}</Link></React.Fragment>
          ))}
        </div>
        {contractDescription && (
          <div className="td-contract">
            <span className="td-contract-label">Contract:</span>{contractDescription}
          </div>
        )}
        {!isNew && <LinkedUpload uploads={uploads.data} />}
        <div className="td-card">
          <div className="td-card-head">
            <span className="td-card-label">DETAILS</span>
            <span className="td-card-tag">INPUT</span>
          </div>
          <div className="td-card-body">
            {isNew ? (
              <Fr label="Renewal of" hint="Renewing an expiring placement carries its treaty detail and structure over and links the two years">
                <select className="fi" value={source} disabled={!canEdit || busy || !sourceList.data}
                  onChange={(e) => pickSource(e.target.value)}>
                  <option value="">{sourceList.data ? 'New business — not a renewal' : 'Loading…'}</option>
                  {sourceList.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.reference} · {s.cedant_name ? `${s.cedant_name} · ` : ''}{s.class} · {s.inception?.slice(0, 4)} · {s.status}
                    </option>
                  ))}
                </select>
              </Fr>
            ) : (
              <Fr label="Placement ID" hint="System id for this placement">
                <Uuid value={p.id} />
              </Fr>
            )}
            {isNew && sourceInfo && (
              <div className="td-hint">
                Source: <b>{sourceInfo.placement.reference}</b> ·
                Class: <b>{sourceInfo.placement.class}</b> ·
                Period: <b>{sourceInfo.placement.inception?.slice(0, 10)} → {sourceInfo.placement.expiry?.slice(0, 10)}</b> ·
                Layers: <b>{sourceInfo.placement.layers?.length ?? 0}</b> ·
                Packs: <b>{sourceInfo.packs.length}</b>
                {latestPack && <> (latest v{latestPack.version} · {latestPack.status})</>}
                {' '}— its structure is loaded on the Expiring Structure tab; the renewal
                incepts when it expires.
              </div>
            )}
            <Fr label="Country" missing={missing.has('Country')}>
              <select className="fi" value={selectValueOf(ref.countries, countrySel)} disabled={!canEdit || busy}
                onChange={(e) => setEd((s) => ({ ...s, countryId: e.target.value, cedantId: '' }))}>
                <option value="">Select country…</option>
                {/* A cedant may be domiciled outside the lookups. */}
                <OffListOption list={ref.countries} value={countrySel} />
                <RefOptions list={ref.countries} />
              </select>
            </Fr>
            <Fr label="Cedant Name" missing={missing.has('Cedant Name')}>
              <select className="fi" value={ed.cedantId} disabled={!canEdit || busy || !countrySel}
                onChange={(e) => setEd((s) => ({ ...s, cedantId: e.target.value }))}>
                <option value="">{countrySel ? 'Select cedant…' : 'Select country first…'}</option>
                {/* The stored cedant stays pickable even while the register loads. */}
                {ed.cedantId && !isNewCedant && !countryCedants.some((c) => c.id === ed.cedantId) && (
                  <option value={ed.cedantId}>{cedName || '…'}</option>
                )}
                {countryCedants.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                {canEdit && <option value={NEW_CEDANT}>＋ New cedant…</option>}
              </select>
            </Fr>
            {isNewCedant && (
              <>
                <Fr label="New Cedant Name" missing={missing.has('Cedant Name')}>
                  <input className="fi" value={ed.cedantName} disabled={busy}
                    onChange={(e) => setEd((s) => ({ ...s, cedantName: e.target.value }))}
                    placeholder="e.g. Atlas Mutual Insurance" />
                </Fr>
                <Fr label="Contact Name">
                  <input className="fi" value={ed.contactName} disabled={busy}
                    onChange={(e) => setEd((s) => ({ ...s, contactName: e.target.value }))} />
                </Fr>
                <Fr label="Contact Email">
                  <input className="fi" type="email" value={ed.contactEmail} disabled={busy}
                    onChange={(e) => setEd((s) => ({ ...s, contactEmail: e.target.value }))} />
                </Fr>
              </>
            )}
            <Fr label="Treaty Type" missing={missing.has('Treaty Type')}>
              <select className="fi" value={selectValueOf(ref.treatyTypes, ed.treatyTypeId)} disabled={!canEdit || busy}
                onChange={(e) => setEd((s) => ({ ...s, treatyTypeId: e.target.value }))}>
                <option value="">Select treaty type…</option>
                <OffListOption list={ref.treatyTypes} value={ed.treatyTypeId} />
                <RefOptions list={ref.treatyTypes} groupBy={(t) => t.category}
                  groupLabel={(g) => CATEGORY_LABELS[g] || g} />
              </select>
            </Fr>
            <Fr label="Line of Business" missing={missing.has('Line of Business')}>
              <button type="button" className="fi cob-trigger" disabled={!canEdit || busy}
                onClick={() => setShowCob(true)}>
                <span className={cobNames.length ? '' : 'cob-placeholder'}>
                  {cobNames.length ? cobNames.join(', ') : 'Select classes…'}
                </span>
                <span className="cob-caret">▾</span>
              </button>
            </Fr>
            <Fr label="Broker">
              <select className="fi" value={selectValueOf(ref.brokers, ed.brokerId)} disabled={!canEdit || busy}
                onChange={(e) => setEd((s) => ({ ...s, brokerId: e.target.value }))}>
                <option value="">Select broker…</option>
                <OffListOption list={ref.brokers} value={ed.brokerId} />
                <RefOptions list={ref.brokers} />
              </select>
            </Fr>
            <Fr label="Currency" missing={missing.has('Currency')}>
              <select className="fi" value={selectValueOf(ref.currencies, ed.currencyId)} disabled={!canEdit || busy}
                onChange={(e) => setEd((s) => ({ ...s, currencyId: e.target.value }))}>
                <OffListOption list={ref.currencies} value={ed.currencyId} />
                <RefOptions list={ref.currencies} label={(c) => c.code || c.name} />
              </select>
            </Fr>
            <Fr label="Treaty Inception Date" missing={missing.has('Treaty Inception Date')}>
              <DateField value={ed.inception} disabled={!canEdit || busy}
                onChange={(e) => setEd((s) => ({ ...s, inception: e.target.value }))} />
            </Fr>
            <Fr label="Treaty Renewal Date" missing={missing.has('Treaty Renewal Date')}
              hint={isNew ? 'Auto = inception + 12 months until edited' : ''}>
              <DateField value={ed.renewal} disabled={!canEdit || busy}
                onChange={(e) => setEd((s) => ({ ...s, renewal: e.target.value, renewalManual: true }))} />
            </Fr>
            <Fr label="UW Year" hint="Auto-derived from Treaty Inception Date">
              <input className="fi fi--readonly" value={ed.inception ? ed.inception.slice(0, 4) : ''} readOnly placeholder="auto" />
            </Fr>
            <Fr label="Experience Start Year">
              <select className="fi" value={ed.expStartYear} disabled={!canEdit || busy}
                onChange={(e) => setEd((s) => ({ ...s, expStartYear: e.target.value }))}>
                <option value="">Select start year…</option>
                {EXP_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </Fr>
            <Fr label="Contract Description">
              <input className="fi fi--readonly td-desc" value={contractDescription} readOnly placeholder="auto" />
            </Fr>
            <Fr label="Notes">
              <input className="fi" value={ed.notes} disabled={!canEdit || busy}
                onChange={(e) => setEd((s) => ({ ...s, notes: e.target.value }))} />
            </Fr>
          </div>
        </div>
        {canEdit && !isNew && (
          <div className="toolbar">
            <button onClick={() => act(async () => {
              const cedantId = await resolveCedantId();
              const parts = [];
              if (brokerName) parts.push(`Broker: ${brokerName}`);
              if (ed.expStartYear) parts.push(`Experience from ${ed.expStartYear}`);
              if (ed.notes.trim()) parts.push(ed.notes.trim());
              await api('PATCH', `/placements/${id}`, {
                class: classString,
                currency: currencyCode,
                inception: ed.inception,
                expiry: ed.renewal,
                // Only a made selection moves the cedant.
                cedant_id: cedantId,
                notes: parts.join(' · ') || undefined,
              });
              placement.reload();
            })}>Save details</button>
          </div>
        )}
        {isNew && (
          <div className="td-hint">
            {detailOk
              ? 'Treaty detail complete — continue through the sections, then Create Placement from the dock.'
              : `Required before the placement can be created: ${[...missing].join(', ')}.`}
          </div>
        )}
        <ErrorBanner error={error} />
        {showCob && (
          <CobModal selected={ed.classIds}
            onSave={(classIds) => setEd((s) => ({ ...s, classIds }))}
            onClose={() => setShowCob(false)} />
        )}
      </>
            )}

            {tab === 'expiring' && (
      <>
        {/* The basis selector, in the Treaty Detail field style. What follows
            is Universe's treaty-detail screen for that basis minus its
            contract-detail panel, which is the first tab. */}
        <div className="td-card">
          <div className="td-card-head">
            <span className="td-card-label">EXPIRING STRUCTURE</span>
            <span className="td-card-head-actions">
              <button type="button" className="np-struct-btn np-struct-btn--accent"
                title={`Enter the ${complementaryLabel(expiring.basis).toLowerCase()} written alongside the expiring treaty`}
                onClick={() => setShowComp(true)}>
                Complementary Cover
                {hasComplementary(expiring) && <> · {complementaryLabel(expiring.basis)} set</>}
              </button>
              <span className="td-card-tag">BASIS</span>
            </span>
          </div>
          <div className="td-card-body">
            <Fr label="Basis" hint="Proportional or non-proportional expiring treaty">
              <BasisPills basis={expiring.basis} readOnly={expiringReadOnly}
                onChange={pickExpiringBasis} />
            </Fr>
            <div className="td-hint">
              {hasProp(expiring.basis)
                ? 'Proportional — the Limit Details, Commissions and Loss Participation cards are active; the non-proportional Structure card sits dimmed. The contract details are those entered on the Treaty Detail tab.'
                : 'Non-proportional — the Structure card and the expiring layers are active; the proportional cards sit dimmed. The contract details are those entered on the Treaty Detail tab.'}
              {isNew && !expiringTouched && basisForTreatyType(treatyTypeRow) && (
                <> Defaulted from the {treatyTypeName} treaty type.</>
              )}
            </div>
          </div>
        </div>

        <ExpiringStructureSection
          value={expiring}
          onChange={setExpiring}
          readOnly={expiringReadOnly}
          currency={p.currency}
          cobRows={cobsExp}
          onCobsChange={canEdit ? setCobsExp : () => {}}
          cobsReadOnly={!canEdit}
          onBasisChange={pickExpiringBasis}
          npTreatyTypes={npTreatyTypes}
          propTreatyTypes={propTreatyTypes}
          hint={expiringHint}
          notice={expiringNotice} />

        {showComp && (
          <ComplementaryCoverModal expiring={expiring} readOnly={expiringReadOnly}
            currency={p.currency} cobNames={parseClass(p.class, ref.treatyTypes).cobs}
            onSave={(complementary) => { setExpiring((s) => ({ ...s, complementary })); setShowComp(false); }}
            onClose={() => setShowComp(false)} />
        )}

        {canEdit && !isNew && (
          <div className="toolbar">
            <button type="button" className="np-green-pill" onClick={saveExpiring}>
              Save expiring structure
            </button>
          </div>
        )}
        <ErrorBanner error={error} />
      </>
            )}

            {tab === 'structure' && (
      <>
        <section className="np-struct-card">
          <div className="np-count-row">
            <label htmlFor="qs-count">Structures to Quote</label>
            <select id="qs-count" className="fi" style={{ width: 120 }} disabled={!canEdit || busy}
              value={String((structures || []).length || 1)}
              onChange={(e) => setStructures(resizeStructures(structures || [], Number(e.target.value), parseClass(p.class, ref.treatyTypes).cobs))}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span className="np-count-hint">Number of alternative structures to quote</span>
            {canEdit && (hasProp(expiring.basis) || realRows(expiring.layers).length > 0) && (
              <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy}
                onClick={() => setStructures(copyExpiringToStructures(expiring, structures || [], parseClass(p.class, ref.treatyTypes).cobs))}>
                ⟳ Copy expiring → structure 1
              </button>
            )}
          </div>
        </section>

        {(structures || []).map((st, i) => (
          <QuoteStructureSection key={i} idx={i} value={st}
            readOnly={!canEdit || busy} currency={p.currency}
            npTreatyTypes={npTreatyTypes}
            propTreatyTypes={propTreatyTypes}
            cobNames={parseClass(p.class, ref.treatyTypes).cobs}
            onChange={(next) => setStructures(structures.map((x, j) => (j === i ? next : x)))} />
        ))}

        {canEdit && !isNew && (
          <div className="toolbar">
            <button type="button" className="np-green-pill" onClick={() => act(async () => {
              // Structure 1 (non-proportional) drives the placement's real layers.
              const s1 = (structures || [])[0];
              if (s1 && s1.basis !== 'PROP') {
                const rows = realRows(s1.layers);
                const keptIds = new Set(rows.filter((r) => r.id).map((r) => r.id));
                for (const l of p.layers || []) {
                  if (!keptIds.has(l.id)) await api('DELETE', `/layers/${l.id}`);
                }
                for (const [i, r] of rows.entries()) {
                  const payload = rowToPayload(r, i, p.currency);
                  if (r.id) await api('PATCH', `/layers/${r.id}`, payload);
                  else await api('POST', `/placements/${id}/layers`, payload);
                }
              }
              await api('PATCH', `/placements/${id}`, {
                structure_cobs: { expiring: cobRowsToPayload(cobsExp) },
                expiring_structure: expiringToPayload(expiring),
                quote_structures: structuresToPayload(structures || []),
              });
              placement.reload();
            })}>Save structure</button>
          </div>
        )}
        <ErrorBanner error={error} />
      </>
            )}

            {tab === 'retentions' && (
      <>
        <StructCard
          title="Table of Retentions"
          hint="Risk class and % of the treaty full limit each occupancy category may use — determines occupancy capacity for the renewal pack."
          actions={<span className="np-layer-count">Categories<b>{retentions.rows.length || '—'}</b></span>}
          footnote="Usable limit = treaty full limit × % of treaty limit — e.g. with a limit of 100, hazardous risks at 60% can only use 60 of the full limit. Class groups occupancies within a risk class (A, B, C or 1, 2, 3). Included in every renewal pack built from this placement.">
          <RetentionsTable value={retentions} onChange={canEdit ? setRetentions : () => {}}
            readOnly={!canEdit || busy} currency={p.currency}
            suggestedLimit={(() => {
              const s1 = structures?.[0];
              if (!s1) return 0;
              return s1.basis === 'PROP'
                ? propCalcs(s1.prop).capacity
                : s1.layers.reduce((t, r) => t + (Number(r.limit) || 0), 0);
            })()} />
          {canEdit && (
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button type="button" className="np-struct-btn" disabled={busy}
                onClick={() => setRetentions({ ...retentions, rows: [...retentions.rows, emptyRetentionRow()] })}>
                ＋ Add category
              </button>
              {!isNew && (
                <button type="button" className="np-green-pill" onClick={() => act(async () => {
                  await api('PATCH', `/placements/${id}`, { retentions: retentionsToPayload(retentions) });
                  placement.reload();
                })}>Save retentions</button>
              )}
            </div>
          )}
          <ErrorBanner error={error} />
        </StructCard>
      </>
            )}

            {tab === 'data' && (isNew
              ? <CreateFirst what="The Data screen reads every screen entered so far, and compares it with the expiring year, so it opens" />
              : (
                <>
                  <PlacementData placementId={id} canEdit={canEdit} canRun={canAnalyse} onOpenScreen={goTab} />
                  <LossEvents placementId={id} currency={p.currency} canEdit={canEdit}
                    hasBound={(p.layers || []).some((l) => ['BOUND', 'CLOSED'].includes(l.status))} />
                </>
              ))}

            {tab === 'pack' && (isNew
              ? <CreateFirst what="The renewal pack is built from the placement's data" />
              : <RenewalPack placementId={id} canEdit={canEdit} canApprove={canApprove} screens={NAV_GROUPS} bases={bases}
                  onOpenScreen={goTab} onPacksChange={packList.reload} />)}

            {tab === 'approval' && (isNew
              ? <CreateFirst what="The pack approval opens" />
              : <RenewalPackApproval placementId={id} canEdit={canEdit} canApprove={canApprove} user={user}
                  onPacksChange={packList.reload} onOpenScreen={goTab} />)}

            {tab === 'negotiation' && (isNew
              ? <CreateFirst what="The quoting stage opens" />
              : negotiationLocked
                ? <NegotiationLocked packs={packList} onOpenPack={() => goTab('approval')} />
                : <Negotiation placementId={id} canEdit={canEdit} canRelease={canRelease} user={user} />)}

            {tab === 'finalquote' && (isNew
              ? <CreateFirst what="The final quote opens" />
              : negotiationLocked
                ? <NegotiationLocked packs={packList} onOpenPack={() => goTab('approval')} />
                : <FinalPlacement placementId={id} canEdit={canEdit} stage="quote" />)}

            {tab === 'final' && (isNew
              ? <CreateFirst what="The final placement opens" />
              : negotiationLocked
                ? <NegotiationLocked packs={packList} onOpenPack={() => goTab('approval')} />
                : <FinalPlacement placementId={id} canEdit={canEdit} stage="placement" />)}

            {/* The modelling screens — the Universe modelling tool's manual
                input workflow, proportional or non-proportional per the
                treaty type, persisting each screen to placement_modelling. */}
            {isModellingTab(tab) && (isNew
              ? <CreateFirst what="The modelling screens save per placement, so they open" />
              : <ModellingPane tab={tab} />)}
          </div>
        </div>
      </div>

      {/* Floating Back/Next through the placement tabs — fades when idle,
          like the modelling tool's wizard dock. On a new placement it also
          carries Create Placement. */}
      <WizardNav
        hasPrev={tabIdx > 0 && !busy}
        hasNext={tabIdx < TABS.length - 1}
        backLabel={TABS[tabIdx - 1]?.label}
        nextLabel={TABS[tabIdx + 1]?.label}
        onBack={() => goTab(TABS[tabIdx - 1].key)}
        onNext={() => goTab(TABS[tabIdx + 1].key)}
        nextDisabled={busy || (isNew && tab === 'detail' && !detailOk)}
        nextTitle={isNew && tab === 'detail' && missing.size ? `Missing: ${[...missing].join(', ')}` : ''}
      >
        {isNew && canEdit && (
          <button type="button" className="wizard-dock-btn wizard-dock-btn--next" disabled={busy || !detailOk}
            title={detailOk ? '' : `Missing: ${[...missing].join(', ')}`}
            onClick={create}>
            {busy ? 'Working…' : 'Create Placement'}
          </button>
        )}
      </WizardNav>
    </ModellingProvider>
  );
}

/** Post-bind loss events: advise a loss, calculate shares + RIP, settle. */
function LossEvents({ placementId, currency, canEdit, hasBound }) {
  const losses = useFetch('GET', `/placements/${placementId}/losses`, [placementId]);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  async function act(fn) {
    setError(null);
    try { await fn(); } catch (e) { setError(e); }
  }

  if (!hasBound && losses.data?.length === 0) return null;

  return (
    <Card title="Treaty losses">
      {canEdit && hasBound && (
        <Form
          submitLabel="Advise loss"
          fields={[
            { name: 'name', label: 'Loss name', required: true, placeholder: 'Warehouse fire' },
            { name: 'loss_date', label: 'Date of loss', type: 'date', required: true },
            { name: 'gross_loss', label: 'Gross loss (FGU)', type: 'number', step: '0.01', required: true },
            { name: 'cat_event', label: 'Cat event', type: 'checkbox' },
          ]}
          onSubmit={async (v) => { await api('POST', `/placements/${placementId}/losses`, v); losses.reload(); }}
        />
      )}
      <ErrorBanner error={error} />
      <ErrorBanner error={losses.error} />
      <table>
        <thead><tr>
          <th>Loss</th><th>Date</th><th>Cat</th><th className="right">Gross loss</th>
          <th className="right">To layers</th><th className="right">Reinst. premium</th><th>Status</th><th />
        </tr></thead>
        <tbody>
          {losses.data?.map((e) => {
            const recovered = e.recoveries.reduce((a, r) => a + Number(r.loss_to_layer), 0);
            const rip = e.recoveries.reduce((a, r) => a + Number(r.reinstatement_premium), 0);
            return (
              <React.Fragment key={e.id}>
                <tr>
                  <td>{e.name}</td>
                  <td>{e.loss_date?.slice(0, 10)}</td>
                  <td>{e.cat_event ? '✓' : ''}</td>
                  <td className="right"><Money amount={e.gross_loss} currency={currency} /></td>
                  <td className="right">{e.recoveries.length ? <Money amount={recovered} currency={currency} /> : '—'}</td>
                  <td className="right">{e.recoveries.length ? <Money amount={rip} currency={currency} /> : '—'}</td>
                  <td><StatusPill value={e.status} /></td>
                  <td className="right toolbar">
                    {canEdit && e.status !== 'settled' && (
                      <button className="small secondary" onClick={() => act(async () => {
                        await api('POST', `/losses/${e.id}/calculate`, {});
                        losses.reload();
                      })}>{e.status === 'advised' ? 'Recalculate' : 'Calculate'}</button>
                    )}
                    {canEdit && e.status === 'advised' && (
                      <button className="small ghost" onClick={() => act(async () => {
                        await api('POST', `/losses/${e.id}/settle`, {});
                        losses.reload();
                      })}>Settle</button>
                    )}
                    {e.recoveries.length > 0 && (
                      <button className="small ghost" onClick={() => setOpen(open === e.id ? null : e.id)}>
                        {open === e.id ? 'Hide' : 'Shares'}
                      </button>
                    )}
                  </td>
                </tr>
                {open === e.id && e.recoveries.map((r) => (
                  <tr key={r.id}>
                    <td colSpan="8">
                      <div className="small" style={{ margin: '4px 0' }}>
                        <strong>{r.layer_name}</strong> — loss to layer <Money amount={r.loss_to_layer} currency={currency} />,
                        reinstatement premium <Money amount={r.reinstatement_premium} currency={currency} />
                        {r.detail?.remaining_aggregate != null && <> · remaining aggregate <Money amount={r.detail.remaining_aggregate} currency={currency} /></>}
                      </div>
                      <table>
                        <thead><tr><th>Market</th><th className="right">Signed</th><th className="right">Recovery due</th><th className="right">Reinst. premium</th></tr></thead>
                        <tbody>
                          {r.detail?.markets?.map((m) => (
                            <tr key={m.market_id}>
                              <td>{m.market_name}</td>
                              <td className="right"><Pct value={m.signed_pct} /></td>
                              <td className="right"><Money amount={m.recovery} currency={currency} /></td>
                              <td className="right"><Money amount={m.reinstatement_premium} currency={currency} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            );
          })}
          {losses.data?.length === 0 && <tr><td colSpan="8" className="muted">No losses advised.</td></tr>}
        </tbody>
      </table>
      {!hasBound && losses.data?.length > 0 && (
        <p className="muted small">Losses shown from a prior bound state.</p>
      )}
    </Card>
  );
}
