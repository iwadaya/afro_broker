// Reference lists (Universe shapes { id, name, code?, category? }) — cached by api.js.
import { useEffect, useState } from 'react';
import { api } from '../../api';

export function useLookups() {
  const [state, setState] = useState({ brokers: [], treatyTypes: [], classes: [], currencies: [], countries: [], ready: false });
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listBrokers().catch(() => []), api.listTreatyTypes().catch(() => []), api.listClassOfBusiness().catch(() => []),
      api.getRefListItems('currency').catch(() => []), api.getRefListItems('country').catch(() => []),
    ]).then(([brokers, treatyTypes, classes, currencies, countries]) => {
      if (cancelled) return;
      const arr = (x) => (Array.isArray(x) ? x : []);
      setState({ brokers: arr(brokers), treatyTypes: arr(treatyTypes), classes: arr(classes), currencies: arr(currencies), countries: arr(countries), ready: true });
    });
    return () => { cancelled = true; };
  }, []);
  return state;
}

/** Cedants filtered by country (Universe: country clears the cedant). */
export function useCedants(countryId) {
  const [cedants, setCedants] = useState([]);
  useEffect(() => {
    if (!countryId) { setCedants([]); return undefined; }
    let cancelled = false;
    api.listCedants({ countryId }).then((r) => { if (!cancelled) setCedants(Array.isArray(r) ? r : []); }).catch(() => { if (!cancelled) setCedants([]); });
    return () => { cancelled = true; };
  }, [countryId]);
  return cedants;
}
