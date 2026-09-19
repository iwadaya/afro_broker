import React from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useFetch, ErrorBanner } from '../../components.jsx';
import { useRefData } from '../../RefData.jsx';
import { contractPath } from './contractModel.js';

/**
 * /contracts/:id — a contract by id, from the renewal calendar, the
 * portfolio, the market intelligence or the top bar's recents: it opens on
 * its basis page (the treaty type decides: proportional or not).
 */
export default function ContractRoute() {
  const { id } = useParams();
  const ref = useRefData();
  const placement = useFetch('GET', `/placements/${id}`, [id]);
  if (placement.error) return <div className="screen"><ErrorBanner error={placement.error} /></div>;
  if (!placement.data || !ref.ready) return null;
  return <Navigate to={contractPath(placement.data, ref.treatyTypes)} replace />;
}

/** /placements/:id — the placement page's old address, kept for bookmarks. */
export function PlacementRedirect() {
  const { id } = useParams();
  return <Navigate to={`/contracts/${id}`} replace />;
}
