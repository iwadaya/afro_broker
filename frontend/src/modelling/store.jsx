import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { cn } from './engine.js';

/* The modelling store — the placement-page equivalent of the Universe
   modelling tool's per-screen persistence. Every screen owns one (or two)
   named sections in placement_modelling; a section is loaded with the rest on
   mount, edited locally, and saved wholesale via PUT. `saveRef` is the
   wizard's onBeforeNext: the active screen registers its save() so switching
   tab flushes unsaved work first, exactly as Universe's WizardLayout does. */

const ModellingContext = createContext(null);

/** A class of business as a section-key suffix: "Credit & Surety" → credit-surety. */
export const cobSlug = (cob) => String(cob || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The section key a screen's data lives under for a class of business. With
 * one class the plain key (as before); with several, `key:class` — each
 * class has its own triangles, losses, profiles, pricing… The first class
 * falls back to the plain key on read, so data saved before a second class
 * was added stays with the class it was entered for.
 */
export const scopedSectionKey = (key, cob, cobs) => ((cobs || []).length > 1 && cob ? `${key}:${cobSlug(cob)}` : key);

export function useModelling() {
  const ctx = useContext(ModellingContext);
  if (!ctx) throw new Error('useModelling outside ModellingProvider');
  return ctx;
}

export function ModellingProvider({ placementId, meta, saveRef: externalSaveRef, children }) {
  const [sections, setSections] = useState(null);
  const [error, setError] = useState(null);
  const internalSaveRef = useRef(null);
  // The host page may own the ref so its navigation can flush the active
  // screen's save before switching tabs.
  const saveRef = externalSaveRef || internalSaveRef;

  // The classes of business the treaty covers: with more than one, every
  // screen holds one set of data per class, and the pills on the screen
  // pick which. The active class survives moving between screens.
  const cobs = useMemo(() => (meta?.cobs || []).filter(Boolean), [meta?.cobs]);
  const multiCob = cobs.length > 1;
  const [activeCob, setActiveCob] = useState(cobs[0] || '');
  useEffect(() => {
    if (!cobs.includes(activeCob)) setActiveCob(cobs[0] || '');
  }, [cobs, activeCob]);

  useEffect(() => {
    let alive = true;
    setSections(null);
    setError(null);
    // A placement that is not created yet has nothing stored.
    if (!placementId) { setSections({}); return undefined; }
    api('GET', `/placements/${placementId}/modelling`)
      .then((res) => { if (alive) setSections(res.sections || {}); })
      .catch((e) => { if (alive) { setError(e); setSections({}); } });
    return () => { alive = false; };
  }, [placementId]);

  const get = useCallback((key) => {
    const scoped = scopedSectionKey(key, activeCob, cobs);
    const own = sections?.[scoped]?.data;
    if (own != null) return own;
    // The first class reads what was saved before the classes were split.
    if (multiCob && activeCob === cobs[0]) return sections?.[key]?.data ?? null;
    return null;
  }, [sections, activeCob, cobs, multiCob]);

  const save = useCallback(async (key, data) => {
    const scoped = scopedSectionKey(key, activeCob, cobs);
    const res = await api('PUT', `/placements/${placementId}/modelling/${scoped}`, { data });
    setSections((s) => ({ ...(s || {}), [scoped]: { data, updated_at: res.updated_at } }));
    return res;
  }, [placementId, activeCob, cobs]);

  // Switching class flushes the active screen's unsaved work first, as
  // moving between screens does; a failed save keeps the current class.
  const switchCob = useCallback(async (cob) => {
    if (cob === activeCob || !cobs.includes(cob)) return;
    if (saveRef.current) {
      let ok = true;
      try { ok = await saveRef.current(); } catch { ok = false; }
      if (ok === false) return;
    }
    setActiveCob(cob);
  }, [activeCob, cobs, saveRef]);

  const value = useMemo(() => ({
    placementId, meta, loading: sections === null, error, sections, get, save, saveRef,
    cobs, activeCob, multiCob, switchCob,
  }), [placementId, meta, sections, error, get, save, cobs, activeCob, multiCob, switchCob]);

  return <ModellingContext.Provider value={value}>{children}</ModellingContext.Provider>;
}

/**
 * Screen-side save contract. The screen hands over its save() (returning
 * true/false); the hook registers it on saveRef while the screen is mounted
 * so tab navigation can flush it. Read-only users (an underwriter reviewing
 * the modelling) never register — their navigation must not attempt writes.
 */
export function useScreenSave(mod, save) {
  const canEdit = !!mod.meta?.canEdit;
  useEffect(() => {
    if (!canEdit) return undefined;
    mod.saveRef.current = save;
    return () => { if (mod.saveRef.current === save) mod.saveRef.current = null; };
  }, [mod.saveRef, save, canEdit]);
}

/* ── Derived reads shared between screens ─────────────────────────────────
   These mirror Universe's cross-screen data flow (loss lists feed selections
   feed dev factors feed pricing) but read from the section store instead of
   per-entity endpoints. */

/** Loss rows of a list section, with incurred + inflated resolved. */
export function lossesOf(store, lossType) {
  const data = store.get(lossType === 'cat' ? 'cat_losses' : 'large_losses');
  const rows = data?.losses || [];
  return rows.map((l) => {
    const incurred = cn(l.incurred) || cn(l.paid) + cn(l.os);
    const factor = cn(l.inflation_factor) || 1;
    return { ...l, incurred, inflation_factor: factor, inflated_incurred: cn(l.inflated_incurred) || incurred * factor };
  });
}

/** Only the selected loss rows (selection defaults to true, as in Universe). */
export function selectedLossesOf(store, lossType) {
  return lossesOf(store, lossType).filter((l) => l.is_selected !== false);
}

/** The saved loss-selection snapshot (threshold, loadings, Pareto params…). */
export function lossSnapshotOf(store, lossType) {
  return store.get(lossType === 'cat' ? 'loss_selection_cat' : 'loss_selection_large') || {};
}

/** Raw large/cat incurred by UW year — the strip amounts for summaries. */
export function lossCategoryByYear(store) {
  const sum = (rows) => {
    const map = new Map();
    for (const l of rows) {
      const yr = Number(l.uw_year);
      if (!Number.isFinite(yr)) continue;
      map.set(yr, (map.get(yr) || 0) + l.incurred);
    }
    return map;
  };
  return { large: sum(selectedLossesOf(store, 'large')), cat: sum(selectedLossesOf(store, 'cat')) };
}

/** Triangle cells for a type from its section, one variant. */
export function triangleCellsOf(store, type, variant = 'MODIFIED') {
  const data = store.get(`triangle_${type}`);
  return data?.[variant]?.cells || [];
}

/** Incurred = paid + OS, cell-wise (the derived triangle). */
export function incurredCellsOf(store, variant = 'MODIFIED') {
  const paid = triangleCellsOf(store, 'paid', variant);
  const os = triangleCellsOf(store, 'os', variant);
  const map = new Map();
  const fold = (cells) => {
    for (const c of cells) {
      const key = `${c.origin_year}:${c.dev_months}`;
      const prev = map.get(key);
      map.set(key, {
        origin_year: Number(c.origin_year),
        dev_months: Number(c.dev_months),
        cum_value: (prev?.cum_value || 0) + (cn(c.cum_value) || 0),
      });
    }
  };
  fold(paid);
  fold(os);
  return [...map.values()];
}

/** Saved chosen CDFs of a dev-factor section, or null when incomplete. */
export function savedCdfsOf(store, type) {
  const data = store.get(`dev_factors_${type}`);
  const factors = data?.factors;
  if (!Array.isArray(factors) || !factors.length) return null;
  const sorted = [...factors].sort((a, b) => (a.dev_month || 0) - (b.dev_month || 0));
  const cdfs = sorted.map((f) => {
    const v = f.chosen_cdf ?? f.selected_cdf ?? null;
    return v != null ? Number(v) : null;
  });
  if (cdfs.some((v) => v == null || !Number.isFinite(v))) return null;
  return cdfs;
}

/** EGNPI per year map from the NP premiums table. */
export function egnpiByYearOf(store) {
  const rows = store.get('np_premiums')?.uwRows || [];
  const map = {};
  for (const r of rows) {
    const y = Number(r.uwYear ?? r.uw_year);
    const v = cn(r.egnpi);
    if (y > 0 && v > 0) map[y] = v;
  }
  return map;
}

/** Premium by year for loss-loading analyses: premium triangle diagonal →
    straight stats → NP EGNPI, whichever is populated (Universe's fallback
    chain, reordered per basis by the caller). */
export function premiumByYearOf(store, basis) {
  if (basis === 'NP') {
    const eg = egnpiByYearOf(store);
    const arr = Object.entries(eg).map(([y, p]) => ({ year: Number(y), premium: p }));
    if (arr.length) return arr.sort((a, b) => a.year - b.year);
  }
  const cells = triangleCellsOf(store, 'premium', 'MODIFIED');
  const byYear = {};
  for (const c of cells) {
    const y = Number(c.origin_year);
    const v = cn(c.cum_value);
    if (!byYear[y] || v > byYear[y]) byYear[y] = v;
  }
  let arr = Object.entries(byYear).map(([y, p]) => ({ year: Number(y), premium: p })).filter((r) => r.premium > 0);
  if (arr.length) return arr.sort((a, b) => a.year - b.year);
  const stats = store.get('straight_stats')?.stats || [];
  arr = stats.map((s) => ({ year: Number(s.year), premium: cn(s.premium) })).filter((r) => r.premium > 0);
  if (arr.length) return arr.sort((a, b) => a.year - b.year);
  const eg = egnpiByYearOf(store);
  return Object.entries(eg).map(([y, p]) => ({ year: Number(y), premium: p })).sort((a, b) => a.year - b.year);
}
