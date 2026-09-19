import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useFetch, Uuid } from '../../components.jsx';
import { Fr, DateField, CobModal } from '../treatyDetail.jsx';
import { useRefData, entryOf, labelOf, selectValueOf, OffListOption, RefOptions } from '../../RefData.jsx';
import { countryOfDomicile, domicileMatches } from '../../refData.js';
import { NEW_CEDANT, headerFromPlacement, classStringOf, buildNotes } from './contractModel.js';
import { defaultRenewalDate, uwYearFromInception, buildContractDescription, EXPERIENCE_YEARS } from './calcs.js';

/* The CONTRACT DETAILS pane of the Universe treaty detail — the left pane of
   both the proportional and the non-proportional screens — and the hook
   that holds its state: the dropdowns are the modelling tool's reference
   lookups (country, cedant filtered by country, treaty type of the screen's
   basis, the classes of business modal, broker, currency), the renewal date
   defaults to inception + 12 months until edited, the UW year and the
   contract description derive live. */

/** The contract details state for a placement (or a new contract), with
    everything the panes derive from it. */
export function useContractHeader({ pd, isNew, basis }) {
  const ref = useRefData();
  // The register, for the country / cedant dropdowns.
  const cedantList = useFetch('GET', '/cedants?limit=500', []);
  const [ed, setEd] = useState(null);
  const [ced, setCed] = useState(null);
  const [showCob, setShowCob] = useState(false);

  // Hydrate from the loaded placement (or start a new contract) once the
  // lookups are in, so the stored names resolve to their rows.
  useEffect(() => {
    if (!pd) return;
    setEd(headerFromPlacement(pd, ref));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pd?.id, pd?.updated_at, ref.ready]);
  useEffect(() => {
    if (!pd?.cedant_id) { setCed(null); return; }
    api('GET', `/cedants/${pd.cedant_id}`).then(setCed).catch(() => {});
  }, [pd?.cedant_id]);
  const update = (patch) => setEd((s) => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  // Universe: the renewal date = inception + 12 months until edited by hand.
  const setInception = (v) => update((s) => ({ inception: v, ...(s.renewalManual ? {} : { renewal: defaultRenewalDate(v) }) }));

  // The treaty types of this screen's basis, and the row the pick refers to.
  const category = basis === 'PROP' ? 'PROPORTIONAL' : 'NON_PROPORTIONAL';
  const treatyTypes = useMemo(
    () => (ref.treatyTypes || []).filter((t) => t.category === category),
    [ref.treatyTypes, category],
  );
  const treatyTypeRow = entryOf(ref.treatyTypes, ed?.treatyTypeId);
  const treatyTypeName = ed ? labelOf(ref.treatyTypes, ed.treatyTypeId) : '';
  const cobNames = (ed?.classIds || []).map((c) => labelOf(ref.classes, c));
  const brokerName = ed ? labelOf(ref.brokers, ed.brokerId) : '';
  const currencyCode = ed ? labelOf(ref.currencies, ed.currencyId, 'code') : '';

  // The country: the edited pick, else the loaded cedant's domicile resolved
  // to its lookup row (so "UK" lands on United Kingdom).
  const countrySel = ed?.countryId
    || (ced?.domicile ? (countryOfDomicile(ced.domicile, ref.countries)?.id || ced.domicile) : '');
  const country = entryOf(ref.countries, countrySel);
  const countryName = labelOf(ref.countries, countrySel);
  const countryCode = country?.code || countryName;
  const countryCedants = (cedantList.data || []).filter((c) => (country
    ? domicileMatches(c.domicile, country)
    : (c.domicile || '').toLowerCase() === String(countrySel).toLowerCase()));
  const isNewCedant = ed?.cedantId === NEW_CEDANT;
  const cedName = isNewCedant
    ? (ed.cedantName || '').trim()
    : ((cedantList.data || []).find((c) => c.id === ed?.cedantId)?.name || ced?.name || '');
  // A cedant is chosen when one is picked, or a new one is named.
  const cedantOk = !!ed?.cedantId && (!isNewCedant || !!(ed.cedantName || '').trim());

  const uwYear = uwYearFromInception(ed?.inception);
  const contractDescription = ed
    ? buildContractDescription({ uwYear, cedantName: cedName, treatyTypeName, classNames: cobNames, countryCode })
    : '';
  const classString = classStringOf(cobNames, treatyTypeName);

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

  /** The placement header the contract details write. */
  function headerPayload() {
    return {
      class: classString,
      inception: ed.inception,
      expiry: ed.renewal,
      currency: currencyCode,
      notes: buildNotes({ brokerName, expStartYear: ed.expStartYear, altContractId: ed.altContractId, notes: ed.notes }),
    };
  }

  /** The slice the Universe required-field rules read. */
  const requiredSlice = {
    countryId: countrySel,
    cedantId: cedantOk ? 'chosen' : '',
    treatyTypeId: ed?.treatyTypeId,
    classIds: ed?.classIds || [],
    brokerId: ed?.brokerId,
    currencyId: ed?.currencyId,
    inceptionDate: ed?.inception,
    experienceStartYear: ed?.expStartYear,
  };

  return {
    ref, ed, update, setInception, isNew, basis, treatyTypes, treatyTypeRow, treatyTypeName, cobNames, brokerName, currencyCode,
    countrySel, country, countryName, countryCode, countryCedants, isNewCedant, cedName, cedantOk,
    uwYear, contractDescription, classString, cedantList, showCob, setShowCob,
    resolveCedantId, headerPayload, requiredSlice,
  };
}

/** The one-line read of the contract at the head of the screen. */
export function ContractSummary({ h, right }) {
  return (
    <div className="td-summary contract-summary" data-testid="contract-summary">
      <span>
        Cedant: <b>{h.cedName || '—'}</b> · Country: <b>{h.countryName || '—'}</b> ·
        Broker: <b>{h.brokerName || '—'}</b> · Currency: <b>{h.currencyCode || '—'}</b> ·
        Treaty Type: <b>{h.treatyTypeName || '—'}</b>
        {h.cobNames.length > 0 && <> · COB: <b>{h.cobNames.join(', ')}</b></>}
      </span>
      {right && <span className="contract-summary-right">{right}</span>}
    </div>
  );
}

/**
 * The CONTRACT DETAILS pane. `missing` is the set of required labels to mark
 * (empty until the first save attempt); `contract` is the saved placement
 * (null while new) for the Contract ID row.
 */
export function ContractDetailsPane({ h, missing, disabled, contract }) {
  const { ed, update, ref, basis } = h;
  if (!ed) return null;
  const miss = (label) => missing.has(label);
  const cobLabel = basis === 'PROP' ? 'Line of Business' : 'Classes of Business';
  return (
    <div className="td-card td-card--pane" data-testid="contract-details">
      <div className="td-card-head">
        <span className="td-card-label">CONTRACT DETAILS</span>
        <span className="td-card-tag">INPUT</span>
      </div>
      <div className="td-card-body">
        <Fr label="Country" missing={miss('Country')}>
          <select className="fi" value={selectValueOf(ref.countries, h.countrySel)} disabled={disabled}
            aria-label="Country"
            onChange={(e) => update({ countryId: e.target.value, cedantId: '' })}>
            <option value="">Select country…</option>
            {/* A cedant may be domiciled outside the lookups. */}
            <OffListOption list={ref.countries} value={h.countrySel} />
            <RefOptions list={ref.countries} />
          </select>
        </Fr>
        <Fr label="Cedant Name" missing={miss('Cedant Name')}>
          <select className="fi" value={ed.cedantId} disabled={disabled || !h.countrySel}
            aria-label="Cedant Name"
            onChange={(e) => update({ cedantId: e.target.value })}>
            <option value="">{h.countrySel ? 'Select cedant…' : 'Select country first…'}</option>
            {/* The stored cedant stays pickable even while the register loads. */}
            {ed.cedantId && !h.isNewCedant && !h.countryCedants.some((c) => c.id === ed.cedantId) && (
              <option value={ed.cedantId}>{h.cedName || '…'}</option>
            )}
            {h.countryCedants.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {!disabled && <option value={NEW_CEDANT}>＋ New cedant…</option>}
          </select>
        </Fr>
        {h.isNewCedant && (
          <>
            <Fr label="New Cedant Name" missing={miss('Cedant Name')}>
              <input className="fi" value={ed.cedantName} disabled={disabled} aria-label="New Cedant Name"
                onChange={(e) => update({ cedantName: e.target.value })}
                placeholder="e.g. Atlas Mutual Insurance" />
            </Fr>
            <Fr label="Contact Name">
              <input className="fi" value={ed.contactName} disabled={disabled}
                onChange={(e) => update({ contactName: e.target.value })} />
            </Fr>
            <Fr label="Contact Email">
              <input className="fi" type="email" value={ed.contactEmail} disabled={disabled}
                onChange={(e) => update({ contactEmail: e.target.value })} />
            </Fr>
          </>
        )}
        <Fr label="Treaty Type" missing={miss('Treaty Type')}>
          <select className="fi" value={selectValueOf(ref.treatyTypes, ed.treatyTypeId)} disabled={disabled}
            aria-label="Treaty Type"
            onChange={(e) => update({ treatyTypeId: e.target.value })}>
            <option value="">Select treaty type…</option>
            <OffListOption list={ref.treatyTypes} value={ed.treatyTypeId} />
            {/* The types of this screen's basis only: proportional here, non-proportional there. */}
            <RefOptions list={h.treatyTypes} />
          </select>
        </Fr>
        <Fr label={cobLabel} missing={miss(cobLabel)}>
          <button type="button" className="fi cob-trigger" disabled={disabled} data-testid="cob-button"
            onClick={() => h.setShowCob(true)}>
            <span className={h.cobNames.length ? '' : 'cob-placeholder'}>
              {h.cobNames.length ? h.cobNames.join(', ') : 'Select classes…'}
            </span>
            <span className="cob-caret">▾</span>
          </button>
        </Fr>
        <Fr label="Broker" missing={miss('Broker')}>
          <select className="fi" value={selectValueOf(ref.brokers, ed.brokerId)} disabled={disabled}
            aria-label="Broker"
            onChange={(e) => update({ brokerId: e.target.value })}>
            <option value="">Select broker…</option>
            <OffListOption list={ref.brokers} value={ed.brokerId} />
            <RefOptions list={ref.brokers} />
          </select>
        </Fr>
        <Fr label="Contract ID" hint="The reference and system id, assigned when the contract is saved">
          {contract
            ? <span className="contract-id"><span className="mono">{contract.reference}</span><Uuid value={contract.id} /></span>
            : <input className="fi fi--readonly" readOnly value="" placeholder="assigned on save" />}
        </Fr>
        <Fr label="Alt. Contract ID">
          <input className="fi" value={ed.altContractId} disabled={disabled} aria-label="Alt. Contract ID"
            onChange={(e) => update({ altContractId: e.target.value })}
            placeholder="External system reference…" />
        </Fr>
        <Fr label="Currency" missing={miss('Currency')}>
          <select className="fi" value={selectValueOf(ref.currencies, ed.currencyId)} disabled={disabled}
            aria-label="Currency"
            onChange={(e) => update({ currencyId: e.target.value })}>
            <OffListOption list={ref.currencies} value={ed.currencyId} />
            <RefOptions list={ref.currencies} label={(c) => c.code || c.name} />
          </select>
        </Fr>
        <Fr label="Treaty Inception Date" missing={miss('Treaty Inception Date')}>
          <DateField value={ed.inception} disabled={disabled} aria-label="Treaty Inception Date"
            onChange={(e) => h.setInception(e.target.value)} />
        </Fr>
        <Fr label="Treaty Renewal Date"
          hint={ed.renewalManual ? '' : 'Defaults to inception + 12 months until edited'}>
          <DateField value={ed.renewal} disabled={disabled} aria-label="Treaty Renewal Date"
            onChange={(e) => update({ renewal: e.target.value, renewalManual: true })} />
        </Fr>
        <Fr label="UW Year" hint="Auto-derived from Treaty Inception Date">
          <input className="fi fi--readonly" readOnly placeholder="auto" aria-label="UW Year"
            value={h.uwYear || ''} />
        </Fr>
        <Fr label="Experience Start Year" missing={miss('Experience Start Year')}>
          <select className="fi" value={ed.expStartYear} disabled={disabled} aria-label="Experience Start Year"
            onChange={(e) => update({ expStartYear: e.target.value })}>
            <option value="">Select start year…</option>
            {EXPERIENCE_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Fr>
        <Fr label="Contract Description">
          <input className="fi fi--readonly td-desc" readOnly placeholder="auto" aria-label="Contract Description"
            data-testid="contract-description" value={h.contractDescription} />
        </Fr>
        <Fr label="Notes">
          <input className="fi" value={ed.notes} disabled={disabled} aria-label="Notes"
            onChange={(e) => update({ notes: e.target.value })} />
        </Fr>
      </div>
      {h.showCob && (
        <CobModal selected={ed.classIds}
          onSave={(classIds) => update({ classIds })}
          onClose={() => h.setShowCob(false)} />
      )}
    </div>
  );
}

/** The focusable controls Enter walks through, pane by pane. */
const FOCUSABLE = 'input:not([disabled]):not([readonly]),select:not([disabled]),button.cob-trigger:not([disabled])';

/**
 * Universe: Enter moves to the next field, and from the last field of a
 * pane to the first of the next. Bound on the grid that holds the panes,
 * reading the grid element from its ref at the keystroke.
 */
export function enterMovesToNextField(gridRef) {
  return (e) => {
    const gridEl = gridRef?.current;
    if (e.key !== 'Enter' || !gridEl) return;
    const t = e.target;
    if (t.tagName !== 'INPUT' && t.tagName !== 'SELECT') return;
    e.preventDefault();
    const panes = Array.from(gridEl.querySelectorAll('.td-card--pane'));
    const focusables = (pane) => Array.from(pane.querySelectorAll(FOCUSABLE));
    const pi = panes.findIndex((p) => p.contains(t));
    if (pi < 0) return;
    const list = focusables(panes[pi]);
    const i = list.indexOf(t);
    if (i >= 0 && i < list.length - 1) list[i + 1].focus();
    else focusables(panes[pi + 1] || panes[pi])[0]?.focus();
  };
}
