import React, { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  useFetch, Blueprint, SectionLabel, StatusPill, Pill, ErrorBanner, SearchInput, fmtDate,
} from '../../components.jsx';
import { useScreenHead } from '../../shell.jsx';
import { useRefData } from '../../RefData.jsx';
import { parseClass, countryOfDomicile } from '../../refData.js';
import { basisOfPlacement, contractPath, BASIS_LABEL } from './contractModel.js';

/**
 * Contracts: two options — Proportional and Non-proportional. Proportional
 * opens the Universe treaty detail (contract details, limit details,
 * commissions, loss participation); Non-proportional opens the contract
 * details pane of the Universe NP treaty detail. Beneath the two, the
 * contracts already on the book, each opening on its own basis.
 */
const BASES = [['', 'All'], ['PROP', 'Proportional'], ['NP', 'Non-proportional']];

export default function ContractsHome() {
  useScreenHead('Placements', 'Contracts');
  const navigate = useNavigate();
  const ref = useRefData();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const [basis, setBasis] = useState('');
  const contracts = useFetch('GET', `/placements?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`, [q]);

  const rows = useMemo(() => (contracts.data || []).map((p) => {
    const { cobs, treatyType } = parseClass(p.class, ref.treatyTypes.length ? ref.treatyTypes : undefined);
    return {
      ...p,
      cob: cobs.join(' / ') || p.class || '—',
      treatyType,
      basis: basisOfPlacement(p, ref.treatyTypes),
      country: countryOfDomicile(p.cedant_domicile, ref.countries)?.name || p.cedant_domicile || '',
      uwYear: p.inception ? String(p.inception).slice(0, 4) : '',
    };
  }), [contracts.data, ref.treatyTypes, ref.countries]);
  const visible = rows.filter((r) => !basis || r.basis === basis);

  const setQ = (value) => {
    const next = new URLSearchParams(params);
    if (value) next.set('q', value); else next.delete('q');
    setParams(next, { replace: true });
  };

  return (
    <div className="screen">
      <section>
        <div className="sechead">
          <SectionLabel>Set up a contract</SectionLabel>
          <span className="hint">pick the basis — the treaty detail follows</span>
        </div>
        <div className="contract-choices" style={{ marginTop: 10 }}>
          <Link to="/contracts/proportional" className="contract-choice" data-testid="contracts-proportional">
            <span className="contract-choice-kicker">PROPORTIONAL</span>
            <span className="contract-choice-title">Proportional treaty</span>
            <span className="contract-choice-sub">
              Quota Share, Quota Share &amp; Surplus, First / Second / Third Surplus, Fac Oblig — the
              treaty detail: contract details, limit details, commissions and loss participation, with
              EPI, brokerage and taxes; then the documents and the shares of the programme.
            </span>
            <span className="contract-choice-arrow">Open the treaty detail →</span>
          </Link>
          <Link to="/contracts/non-proportional" className="contract-choice" data-testid="contracts-non-proportional">
            <span className="contract-choice-kicker">NON-PROPORTIONAL</span>
            <span className="contract-choice-title">Non-proportional treaty</span>
            <span className="contract-choice-sub">
              Risk XL, CAT XL, Risk &amp; CAT XL, Stop Loss, Aggregate XL — the non-proportional
              treaty detail: the contract details, and the structure terms (layers, deductible,
              retention, accounting, premium and commissions); then the documents and the shares of the
              programme.
            </span>
            <span className="contract-choice-arrow">Open the contract details →</span>
          </Link>
        </div>
      </section>

      <section className="contract-register" data-testid="contract-register">
        <div className="sechead">
          <SectionLabel>
            Contracts on the book
            {contracts.data && ` · ${visible.length} ${visible.length === 1 ? 'contract' : 'contracts'}`}
          </SectionLabel>
          <span className="hint">open a row to work the contract on its basis</span>
          <div className="sechead-actions">
            <div className="segmini" role="group" aria-label="Basis">
              {BASES.map(([value, label]) => (
                <button key={label} type="button" className={`segbtn${basis === value ? ' on' : ''}`}
                  onClick={() => setBasis(value)}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        <ErrorBanner error={contracts.error} />
        <Blueprint className="packstore" style={{ marginTop: 10 }}>
          <div className="filterbar">
            <div className="filterbar-search">
              <SearchInput value={q} onChange={setQ} placeholder="Search by reference, cedant or class…" label="Search contracts" />
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th><th className="cell-cedant">Cedant</th><th>Class of business</th><th>Treaty type</th>
                  <th>Basis</th><th>UW year</th><th>Renews</th><th>Ccy</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} data-testid="contract-row">
                    <td>
                      <button type="button" className="refbtn" onClick={() => navigate(contractPath(r, ref.treatyTypes))}>
                        {r.reference}
                      </button>
                    </td>
                    <td className="cell-cedant">
                      <span className="person-name">{r.cedant_name}</span>
                      {r.country && <span className="person-meta">{r.country}</span>}
                    </td>
                    <td>{r.cob}</td>
                    <td>{r.treatyType ? <span className="classtag">{r.treatyType}</span> : <span className="muted">—</span>}</td>
                    <td><Pill tone={r.basis === 'PROP' ? 'green' : 'blue'}>{BASIS_LABEL[r.basis]}</Pill></td>
                    <td className="mono">{r.uwYear || '—'}</td>
                    <td className="mono" style={{ fontSize: 12.5 }}>{fmtDate(r.expiry, { shortYear: true })}</td>
                    <td className="mono">{r.currency}</td>
                    <td><StatusPill value={r.status} /></td>
                    <td className="r">
                      <button type="button" className="btn btn-secondary btn-sm"
                        onClick={() => navigate(contractPath(r, ref.treatyTypes))}>Open</button>
                    </td>
                  </tr>
                ))}
                {contracts.data && visible.length === 0 && (
                  <tr><td colSpan="10" className="muted">{q || basis ? 'No contracts match.' : 'No contracts yet — set one up above.'}</td></tr>
                )}
                {!contracts.data && !contracts.error && (
                  <tr><td colSpan="10" className="muted">Loading…</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Blueprint>
      </section>
    </div>
  );
}
