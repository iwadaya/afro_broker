import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { useAuth } from './auth.jsx';

/**
 * Workspace context: the working placement and layer. The dashboard
 * signing chooser lists it first, and the wording library reads the layer.
 * Claims & premium has its own portfolio-wide entry. Screens
 * update it as the user navigates; on a fresh session it resolves to the
 * placement furthest through the market from the renewal calendar.
 */
const WorkspaceContext = createContext(null);

const STATUS_RANK = [
  'DRAFT', 'DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED', 'FOT_AGREED',
  'FOLLOW_MARKETING', 'INCOMPLETE', 'LINES_WRITTEN', 'SIGNED', 'BOUND',
];

export function WorkspaceProvider({ children }) {
  const [placement, setPlacementState] = useState(null);
  const [layer, setLayerState] = useState(null);
  const [badges, setBadges] = useState({});
  // True once the default context has been looked for — found or not — so a
  // screen that opens on the working placement can wait for it on a direct load.
  const [ready, setReady] = useState(false);

  const setPlacement = (p) => setPlacementState((cur) => (p && cur?.id === p.id ? cur : p));
  const setLayer = (l) => setLayerState((cur) => (l && cur?.id === l.id ? cur : l));

  // Resolve the default working context once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cal = await api('GET', '/dashboards/renewal-calendar?days=225');
        if (!alive) return;
        const renewals = cal.renewals || [];
        const pick = renewals.slice().sort((a, b) =>
          STATUS_RANK.indexOf(b.status) - STATUS_RANK.indexOf(a.status))[0];
        if (!pick) return;
        const full = await api('GET', `/placements/${pick.id}`);
        if (!alive) return;
        setPlacementState((cur) => cur || full);
        const layers = full.layers || [];
        const hot = layers.find((l) => l.status !== 'OPEN') || layers[0] || null;
        if (hot) setLayerState((cur) => cur || { ...hot, placement: full });
      } catch {
        /* unauthenticated or empty book — the launcher simply has no context */
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Contextual badges (pack version, written total, wording in review).
  useEffect(() => {
    if (!placement?.id) return;
    api('GET', `/placements/${placement.id}/packs`)
      .then((packs) => setBadges((b) => ({ ...b, pack: packs[0] ? `v${packs[0].version}` : null, claims: '10y' })))
      .catch(() => {});
  }, [placement?.id]);
  useEffect(() => {
    if (!layer?.id) return;
    api('GET', `/layers/${layer.id}/signing/preview`)
      .then((p) => setBadges((b) => ({
        ...b,
        layer: layer.position ? `L${layer.position}` : null,
        signing: p.writtenTotal ? String(Math.round(p.writtenTotal * 10) / 10) : null,
        panel: p.lines?.length || null,
      })))
      .catch(() => {});
  }, [layer?.id]);
  useEffect(() => {
    api('GET', '/dashboards/outstanding')
      .then((o) => setBadges((b) => ({ ...b, wording: o.counts?.wording_in_review || null })))
      .catch(() => {});
  }, []);

  const value = useMemo(() => ({ placement, layer, setPlacement, setLayer, badges, ready }),
    [placement, layer, badges, ready]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}

/**
 * The "acting as" lens from the design's role switcher. It shapes what the UI
 * offers (role notes, which actions are surfaced); the backend still enforces
 * real RBAC and four-eyes on every call, so a capability is only offered when
 * the signed-in user's real role can actually perform it.
 */
const RoleContext = createContext(null);

const DEFAULT_LENS = { broker: 'Broker', senior_broker: 'Broker', underwriter: 'Underwriter', admin: 'Broker' };

export const ROLE_NOTES = {
  Broker: 'Builds packs, markets the risk, writes lines. A Senior Broker also approves renewal packs before they go to market. Cannot authorise its own FOT or bind.',
  Analyst: 'Owns bordereaux, exhibits and pack approval. Read-only on the market side.',
  Underwriter: 'Second pair of eyes: authorises firm order terms and bind, and signs off wording changes.',
};

export function RoleProvider({ children }) {
  const { user } = useAuth();
  const [actingAs, setActingAs] = useState(DEFAULT_LENS[user?.role] || 'Broker');
  useEffect(() => { setActingAs(DEFAULT_LENS[user?.role] || 'Broker'); }, [user?.role]);

  const realRole = user?.role;
  const value = useMemo(() => ({
    actingAs,
    setActingAs,
    realRole,
    // The lens narrows; the real role decides what the server would accept.
    canBroke: actingAs !== 'Underwriter' && ['broker', 'senior_broker', 'admin'].includes(realRole),
    canAuthorise: actingAs === 'Underwriter' && ['underwriter', 'admin'].includes(realRole),
  }), [actingAs, realRole]);
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  return useContext(RoleContext);
}

/** Screen header (crumb · title · tag) — set by the active screen. */
const HeaderContext = createContext(null);

export function HeaderProvider({ children }) {
  const [head, setHead] = useState({ crumb: '', title: '', tag: null });
  const value = useMemo(() => ({ head, setHead }), [head]);
  return <HeaderContext.Provider value={value}>{children}</HeaderContext.Provider>;
}

export function useHeader() {
  return useContext(HeaderContext);
}

/** Declare the screen's header. Pass stable primitives. */
export function useScreenHead(crumb, title, tag = null) {
  const { setHead } = useHeader();
  useEffect(() => {
    setHead({ crumb, title, tag });
  }, [crumb, title, tag, setHead]);
}

