import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth.jsx';

/**
 * The "acting as" lens from the design's role switcher. It shapes what the UI
 * offers (role notes, which actions are surfaced); the backend still enforces
 * real RBAC and four-eyes on every call, so a capability is only offered when
 * the signed-in user's real role can actually perform it.
 */
const RoleContext = createContext(null);

const DEFAULT_LENS = { broker: 'Broker', senior_broker: 'Broker', underwriter: 'Underwriter', admin: 'Broker' };

export const ROLE_NOTES = {
  Broker: 'Sets up the contracts and reads the book. A Senior Broker also approves renewal packs before they go to market. Cannot authorise its own FOT or bind.',
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
