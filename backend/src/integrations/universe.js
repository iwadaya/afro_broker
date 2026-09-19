import { config } from '../config.js';

/**
 * Universe integration boundary (design doc §4).
 *
 * Pull: technical rate / modelled output per layer (burning cost, exposure
 * rate, cat load) to display beside market quotes as the benchmark.
 * Push: when Saudi Re is on a bound layer, confirm the inwards contract.
 *
 * Broking never writes pricing; Universe never writes lines. When Universe is
 * not configured (no UNIVERSE_API_URL), the pull returns a deterministic stub
 * so the rest of the system — quote board, packs — stays exercisable offline.
 */

export function isConfigured() {
  return Boolean(config.universe.apiUrl);
}

export async function pullTechnical(layer) {
  if (!isConfigured()) {
    return stubTechnical(layer);
  }
  const url = `${config.universe.apiUrl.replace(/\/$/, '')}/technical/${encodeURIComponent(layer.technical_ref || layer.id)}`;
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${config.universe.apiKey}`, accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Universe technical pull failed: ${resp.status}`);
  }
  const data = await resp.json();
  return { source: 'universe', ...data };
}

/**
 * Deterministic placeholder benchmark derived from the layer itself, so the
 * quote board has a technical column to compare against without Universe.
 *
 * The rate is expressed in percent (e.g. 14.8 = 14.80% ROL) and derived from
 * the layer's geometry — a higher rate low in the programme, decaying as the
 * attachment rises — rather than from the broker's own premium, which would
 * be circular as a benchmark. Layers without a limit have no benchmark.
 */
function stubTechnical(layer) {
  const limit = Number(layer.limit_amt) || 0;
  const attachment = Number(layer.attachment) || 0;
  const rateOnLine = limit > 0
    ? Math.round((limit / (attachment + limit)) * 22.2 * 100) / 100
    : null;
  return {
    source: 'stub',
    technical_ref: layer.technical_ref || null,
    burning_cost_rate: rateOnLine != null ? Math.round(rateOnLine * 0.7 * 100) / 100 : null,
    exposure_rate: rateOnLine != null ? Math.round(rateOnLine * 0.9 * 100) / 100 : null,
    cat_load: rateOnLine != null ? Math.round(rateOnLine * 0.15 * 100) / 100 : null,
    technical_rate_on_line: rateOnLine,
    note: 'Universe not configured; deterministic benchmark derived from layer geometry.',
  };
}

export async function confirmInwardsContract(layer, lines) {
  if (!isConfigured()) {
    return { pushed: false, reason: 'Universe not configured' };
  }
  const url = `${config.universe.apiUrl.replace(/\/$/, '')}/inwards/confirm`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.universe.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ technical_ref: layer.technical_ref, layer_id: layer.id, lines }),
  });
  return { pushed: resp.ok, status: resp.status };
}
