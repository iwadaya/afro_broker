import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Notice, NumCell, useSaveMsg, pasteGrid, pasteNum, ModModal, basisLabel } from './bits.jsx';
import { useModelling, useScreenSave } from './store.jsx';
import { cn, fmtC } from './engine.js';

/* CRESTA aggregates — ported from the modelling tool's CrestaAggregates
   screen: earthquake / flood / SRCC / windstorm / other aggregate exposure
   per CRESTA zone for the cedant's country, with the occupancy distribution
   (must total 100%) and a combined single-row mode when zone detail isn't
   available. Broker IQ has no reference zone table, so zones start as
   editable Zone 1–10 placeholders and the zone names can be typed over. */

const PERILS = [
  { key: 'eq_agg', label: 'EARTHQUAKE' },
  { key: 'flood_agg', label: 'FLOOD' },
  { key: 'srcc_agg', label: 'SRCC' },
  { key: 'ws_agg', label: 'WINDSTORM' },
  { key: 'others_agg', label: 'OTHERS' },
];
const DIST_CATS = [
  { key: 'residential_bldg_pct', label: 'Residential Buildings' },
  { key: 'commercial_bldg_pct', label: 'Commercial Buildings' },
  { key: 'commercial_cont_pct', label: 'Commercial Contents' },
  { key: 'industrial_bldg_pct', label: 'Industrial Buildings' },
  { key: 'industrial_cont_pct', label: 'Industrial Contents' },
];
const DEFAULT_DIST = { residential_bldg_pct: 30, commercial_bldg_pct: 25, commercial_cont_pct: 15, industrial_bldg_pct: 20, industrial_cont_pct: 10 };

const blankZones = () => Array.from({ length: 10 }, (_, i) => ({
  zone_id: String(i + 1), zone_name: `Zone ${i + 1}`, eq_agg: '', flood_agg: '', srcc_agg: '', ws_agg: '', others_agg: '',
}));
const combinedZone = () => [{ zone_id: 'COMBINED', zone_name: 'Combined', eq_agg: '', flood_agg: '', srcc_agg: '', ws_agg: '', others_agg: '' }];

export default function CrestaScreen() {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const section = 'cresta';

  const [rows, setRows] = useState(blankZones());
  const [dist, setDist] = useState({ ...DEFAULT_DIST });
  const [combined, setCombined] = useState(false);
  const [showDist, setShowDist] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  useEffect(() => {
    const data = get(section);
    if (data?.zones?.length) {
      setRows(data.zones.map((z) => ({
        zone_id: z.zone_id ?? '',
        zone_name: z.zone_name ?? '',
        eq_agg: z.eq_agg != null ? String(z.eq_agg) : '',
        flood_agg: z.flood_agg != null ? String(z.flood_agg) : '',
        srcc_agg: z.srcc_agg != null ? String(z.srcc_agg) : '',
        ws_agg: z.ws_agg != null ? String(z.ws_agg) : '',
        others_agg: z.others_agg != null ? String(z.others_agg) : '',
      })));
      setCombined(data.zones.length === 1 && String(data.zones[0].zone_id) === 'COMBINED');
    } else {
      setRows(blankZones());
      setCombined(false);
    }
    setDist({ ...DEFAULT_DIST, ...(data?.distribution || {}) });
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections]);

  const totals = useMemo(() => {
    const t = {};
    PERILS.forEach((p) => { t[p.key] = rows.reduce((s, r) => s + cn(r[p.key]), 0); });
    return t;
  }, [rows]);
  const distTotal = DIST_CATS.reduce((s, c) => s + cn(dist[c.key]), 0);

  const updateCell = (i, key, val) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: val } : r)));
    setDirty(true);
  };

  const handlePaste = (e, rowIdx, perilIdx) => {
    const grid = pasteGrid(e);
    if (!grid) return;
    e.preventDefault();
    setRows((prev) => {
      const next = prev.map((r) => ({ ...r }));
      grid.forEach((pr, rOff) => {
        const rr = rowIdx + rOff;
        if (!next[rr]) return;
        pr.forEach((val, cOff) => {
          const cc = perilIdx + cOff;
          if (cc >= PERILS.length) return;
          next[rr][PERILS[cc].key] = pasteNum(val);
        });
      });
      return next;
    });
    setDirty(true);
  };

  const toggleCombined = (checked) => {
    setRows(checked ? combinedZone() : blankZones());
    setCombined(checked);
    setDirty(true);
  };

  const doSave = async () => {
    if (!dirty) return true;
    if (Math.abs(distTotal - 100) > 0.01) {
      flash('err', `Occupancy distribution must total 100% (currently ${distTotal.toFixed(1)}%)`);
      return false;
    }
    try {
      const zones = rows
        .filter((r) => PERILS.some((p) => String(r[p.key]).trim() !== ''))
        .map((r) => ({
          zone_id: r.zone_id, zone_name: r.zone_name,
          eq_agg: cn(r.eq_agg) || null, flood_agg: cn(r.flood_agg) || null,
          srcc_agg: cn(r.srcc_agg) || null, ws_agg: cn(r.ws_agg) || null, others_agg: cn(r.others_agg) || null,
        }));
      await save(section, {
        combined,
        zones: zones.length ? zones : rows.map((r) => ({ zone_id: r.zone_id, zone_name: r.zone_name })),
        distribution: DIST_CATS.reduce((acc, c) => ({ ...acc, [c.key]: cn(dist[c.key]) }), {}),
      });
      setDirty(false);
      flash('ok', 'Aggregates saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  return (
    <ModScreen pill={`${basisLabel(meta)} TREATY: CRESTA ZONES`}
      title="Aggregate Exposure by CRESTA Zone"
      sub="Earthquake, flood, SRCC and windstorm aggregates per zone. Only meaningful for Fire, Engineering & Energy classes; use Combined when the cedant reports one country total."
      actions={(
        <SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit}
          extra={(
            <>
              <label className="mod-check-label">
                <input type="checkbox" className="np-check" checked={combined} disabled={!meta.canEdit}
                  onChange={(e) => toggleCombined(e.target.checked)} /> Combined aggregates
              </label>
              <button type="button" className="np-struct-btn" onClick={() => setShowDist(true)}>📊 Distribution</button>
              {meta.canEdit && (
                <button type="button" className="np-struct-btn" onClick={() => {
                  setRows((prev) => prev.map((r) => ({ ...r, eq_agg: '', flood_agg: '', srcc_agg: '', ws_agg: '', others_agg: '' })));
                  setDirty(true);
                }}>Clear</button>
              )}
            </>
          )} />
      )}>

      <div className="tri-info-bar">
        <div className="tri-info-item">Country <b>{meta.country || '—'}</b></div>
        <div className="tri-info-item">Occupancy split <b>{distTotal.toFixed(0)}%</b> {Math.abs(distTotal - 100) < 0.01 ? '✓' : '⚠'}</div>
        <div className="tri-info-item tri-info-item--accent">Total aggregate <b>{fmtC(PERILS.reduce((s, p) => s + totals[p.key], 0))}</b></div>
      </div>
      {!combined && (
        <Notice tone="info">No CRESTA reference zones are seeded for this country — the Zone 1–10 placeholders below are editable, so type over the zone names as reported.</Notice>
      )}

      <div className="np-table-wrap">
        <table className="mod-table">
          <thead>
            <tr>
              <th className="mod-cell--center" style={{ width: 80 }}>ZONE #</th>
              <th>CRESTA ZONE</th>
              {PERILS.map((p) => <th key={p.key} className="mod-num">{p.label} ({meta.currency})</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input className="mod-cell mod-cell--center" value={r.zone_id} readOnly={!meta.canEdit || combined}
                    onChange={(e) => updateCell(i, 'zone_id', e.target.value)} />
                </td>
                <td>
                  <input className="mod-cell mod-cell--left" value={r.zone_name} readOnly={!meta.canEdit || combined}
                    onChange={(e) => updateCell(i, 'zone_name', e.target.value)} />
                </td>
                {PERILS.map((p, pi) => (
                  <td key={p.key}>
                    <NumCell value={r[p.key]} readOnly={!meta.canEdit}
                      onChange={(v) => updateCell(i, p.key, v)}
                      onPaste={(e) => handlePaste(e, i, pi)} />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="mod-total-row">
              <td colSpan={2}><b>Total</b></td>
              {PERILS.map((p) => <td key={p.key} className="mod-num"><b>{totals[p.key] ? fmtC(totals[p.key]) : '—'}</b></td>)}
            </tr>
          </tbody>
        </table>
      </div>

      {showDist && (
        <ModModal title="Occupancy Distribution" sub="Distribute aggregate exposure between occupancy categories — must total 100%."
          onClose={() => setShowDist(false)}>
          <div className="ca-dist-grid">
            {DIST_CATS.map((c) => (
              <div key={c.key} className="ca-dist-row">
                <span className="ca-dist-label">{c.label}</span>
                <NumCell value={String(dist[c.key] ?? '')} readOnly={!meta.canEdit} align="center" className="mod-cell--w90"
                  onChange={(v) => { setDist((p) => ({ ...p, [c.key]: v })); setDirty(true); }} />
                <div className="ca-dist-bar"><div className="ca-dist-fill" style={{ width: `${Math.min(100, cn(dist[c.key]))}%` }} /></div>
              </div>
            ))}
          </div>
          <div className={`ca-dist-total${Math.abs(distTotal - 100) < 0.01 ? ' ca-dist-total--ok' : ' ca-dist-total--err'}`}>
            Total <b>{distTotal.toFixed(1)}%</b>{Math.abs(distTotal - 100) < 0.01 ? ' ✓' : ' — must equal 100%'}
          </div>
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button type="button" className="np-struct-btn" onClick={() => { setDist({ ...DEFAULT_DIST }); setDirty(true); }}>Reset to defaults</button>
            <button type="button" className="np-green-pill" onClick={() => setShowDist(false)}>Done</button>
          </div>
        </ModModal>
      )}
    </ModScreen>
  );
}
