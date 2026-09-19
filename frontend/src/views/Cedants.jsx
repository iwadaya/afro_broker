import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Card, useFetch, Form, ErrorBanner } from '../components.jsx';
import { useScreenHead } from '../shell.jsx';
import { useHasRole } from '../auth.jsx';
import { useRefData } from '../RefData.jsx';
import { countryOfDomicile } from '../refData.js';

/**
 * Cedants — the clients we place for. Each one gets an entry on the Insurers
 * tab of the market register, which is where its KYC file and group profile
 * live; the link in the table goes there.
 *
 * A cedant is registered under a country from the reference list (stored as
 * its code), because the placement page's Cedant Name dropdown offers the
 * cedants of the country picked above it — a cedant without a recognised
 * country would never be offered.
 */
export default function Cedants() {
  const cedants = useFetch('GET', '/cedants?limit=200');
  const canEdit = useHasRole('broker', 'admin');
  const ref = useRefData();
  useScreenHead('Counterparties', 'Cedants');

  // The country lookup rows ({ id, name, code }); the domicile stored is the
  // country name, as the placement page stores it for a cedant registered
  // there, which its country → cedant filter resolves.
  const countries = [...(ref.countries || [])].sort((a, b) => a.name.localeCompare(b.name));
  // A stored domicile reads as its reference name ("UK" → United Kingdom);
  // one the list does not carry shows as stored, flagged.
  const countryLabel = (domicile) => {
    if (!domicile) return null;
    const c = countryOfDomicile(domicile, ref.countries);
    return c ? c.name : `${domicile} (not in the country list)`;
  };

  return (
    <>
      <Card title="Cedants">
        {canEdit && (
          <Form
            submitLabel="Add cedant"
            fields={[
              { name: 'name', label: 'Name', required: true },
              {
                name: 'domicile', label: 'Country', type: 'select', required: true,
                options: countries.map((c) => ({ value: c.name, label: c.name })),
              },
            ]}
            onSubmit={async (v) => { await api('POST', '/cedants', v); cedants.reload(); }}
          />
        )}
        <ErrorBanner error={cedants.error} />
        <table>
          <thead><tr><th>Name</th><th>Country</th><th>Register entry</th></tr></thead>
          <tbody>
            {cedants.data?.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{countryLabel(c.domicile) || <span className="muted">— (no country: not offered on a placement)</span>}</td>
                <td>
                  {c.market_id
                    ? <Link to={`/markets/${c.market_id}`}>Compliance &amp; profile</Link>
                    : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
            {cedants.data?.length === 0 && <tr><td colSpan="3" className="muted">No cedants.</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}
