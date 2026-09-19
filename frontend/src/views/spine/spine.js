import { useEffect, useState } from 'react';
import { api } from '../../api.js';

/**
 * Shared helpers for the spine workspace (§1.2). Everything here reads what
 * the API said — amounts arrive as decimal display strings alongside the
 * stored minor units, so nothing is re-derived in the browser (§2.6).
 */

/**
 * A one-line read of what a version says, in the terms that matter for its
 * basis. Same summary as the Contracts screen, so a structure never reads two
 * ways.
 */
export function summariseTerms(basis, version) {
  if (!version) return '—';
  const t = version.terms_display || version.terms || {};
  const ccy = t.currency || '';
  if (basis === 'NP') {
    const parts = [`${ccy} ${t.limit ?? '?'} xs ${t.deductible ?? '?'}`];
    if (t.rate_pct != null) parts.push(`@ ${t.rate_pct}%`);
    return parts.join(' ');
  }
  const cession = t.lines_ceded != null ? `${t.lines_ceded} lines` : `${t.cession_pct ?? '?'}%`;
  const parts = [cession];
  if (t.retention != null) parts.push(`retention ${ccy} ${t.retention}`);
  if (t.commission_pct != null) parts.push(`comm ${t.commission_pct}%`);
  else if (t.sliding_scale) parts.push('sliding scale');
  return parts.join(' · ');
}

/** `Cat XL Layer 1 · v3 SUBMITTED` — how a version is named wherever one is picked. */
export function versionTag(v) {
  return `${v.structure_label ?? v.label ?? ''} · v${v.version_no} ${v.status}`;
}

/**
 * Every version of every structure on the year, flattened and labelled, for
 * the pickers (which versions go to market, which are quoted to the cedant).
 * Bumping `reloadKey` refetches after a version is added elsewhere.
 */
export function useAllVersions(structures, reloadKey = 0) {
  const [state, setState] = useState({ versions: [], loading: true, error: null });
  useEffect(() => {
    if (!structures) return undefined;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    Promise.all(structures.map((s) => api('GET', `/structures/${s.id}`)))
      .then((full) => alive && setState({
        loading: false,
        error: null,
        versions: full.flatMap((f) => f.versions.map((v) => ({
          ...v,
          structure_label: f.label,
          basis: f.basis,
        }))),
      }))
      .catch((error) => alive && setState({ versions: [], loading: false, error }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structures, reloadKey]);
  return state;
}

/** Parse a JSON textarea, with a message that says what to fix. */
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Terms must be valid JSON');
  }
}
