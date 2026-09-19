import React, { useState } from 'react';
import { fmtCompact, fmtPct } from '../../components.jsx';
import {
  REINSTATEMENT_OPTIONS, DEFAULT_SLIDING, DEFAULT_CORRIDOR, DEFAULT_AGGREGATE, DEFAULT_QS, DEFAULT_SURPLUS,
  SCAN_OPTIONS, withKey, cloneStructure, num,
} from './model.js';
import { Tower } from './charts.jsx';
import { Section, Note, NumberField, Toggle } from './bits.jsx';

/*
 * 02 Programme — the current programme as the placements carry it, and the
 * proposed one beside it. Each is drawn as a tower first (to one shared
 * scale, so a moved retention is visible before a number is read) and
 * edited underneath: the quota share and its loss-sensitive terms, the
 * surplus (a line and a number of lines, reading the book's risk profile),
 * the excess-of-loss layers, the stop loss on what is kept. The
 * reinstatement, placing and deductible columns stay folded until they are
 * needed.
 */

/** Whether any layer carries something other than the defaults in the folded columns. */
function hasDetail(s) {
  return (s?.xol_layers || []).some((l) => num(l.reinstatement_pct, 100) !== 100
    || num(l.placed_pct, 100) !== 100 || num(l.aggregate_deductible) > 0);
}

const LAYER_TITLES = {
  limit: 'The most the layer pays on one event.',
  attachment: 'The layer starts paying above this loss to the retained account (after the quota share).',
  premium: 'At 100% of the layer. Leave it blank and the model prices the layer off its own simulated recoveries.',
  reinstatements: 'How many times the limit is restored in a year. ∞ is unlimited.',
  rip: 'Premium to restore a used limit, as a share of the layer premium.',
  placed: 'The share of the layer actually placed with reinsurers.',
  aad: 'Annual aggregate deductible: otherwise-recoverable loss the cedant keeps first each year.',
};

function StructurePanel({ title, kicker, lede, value, onChange, ccy, top, actions, children, testid, subjectPremium, profileNote }) {
  const [detail, setDetail] = useState(() => hasDetail(value));
  if (!value) return null;
  const qs = value.quota_share;
  const sp = value.surplus;
  const agg = value.aggregate;

  const setQs = (patch) => onChange((s) => ({ ...s, quota_share: { ...s.quota_share, ...patch } }));
  const setSp = (patch) => onChange((s) => ({ ...s, surplus: { ...s.surplus, ...patch } }));
  const setSliding = (patch) => setQs({ sliding_scale: { ...qs.sliding_scale, ...patch } });
  const setCorridor = (patch) => setQs({ loss_corridor: { ...qs.loss_corridor, ...patch } });
  const setAgg = (patch) => onChange((s) => ({ ...s, aggregate: { ...s.aggregate, ...patch } }));
  const setLayer = (key, patch) => onChange((s) => ({
    ...s,
    xol_layers: s.xol_layers.map((l) => (l._key === key ? { ...l, ...patch } : l)),
  }));
  const dropLayer = (key) => onChange((s) => ({ ...s, xol_layers: s.xol_layers.filter((l) => l._key !== key) }));
  const addLayer = () => onChange((s) => {
    const topOf = s.xol_layers.reduce((a, l) => Math.max(a, num(l.attachment) + num(l.limit)), 0);
    return {
      ...s,
      xol_layers: [...s.xol_layers, withKey({
        name: `Layer ${s.xol_layers.length + 1}`, attachment: topOf, limit: '', premium100: '',
        reinstatements: '1', reinstatement_pct: 100, placed_pct: 100, aggregate_deductible: 0,
      })],
    };
  });
  const numIn = (v) => (v === '' ? '' : Number(v));
  const nameOf = (l) => l.name || 'layer';

  return (
    <Section title={title} hint={kicker} actions={actions} testid={testid}>
      <div className="blueprint dfa-panel dfa-structure">
        <p className="dfa-lede">{lede}</p>
        <Tower structure={value} top={top} ccy={ccy} />

        <div className="dfa-block">
          <div className="dfa-block-head">
            <Toggle
              checked={!!qs}
              testid={`${testid}-qs`}
              onChange={(on) => onChange((s) => ({
                ...s,
                quota_share: on
                  ? {
                    ...DEFAULT_QS, inferred: false,
                    sliding: false, sliding_scale: { ...DEFAULT_SLIDING },
                    corridor: false, loss_corridor: { ...DEFAULT_CORRIDOR },
                  }
                  : null,
              }))}
              title="A fixed share of every risk and every loss goes to the reinsurers, for a commission on the premium."
            >
              <b>Quota share</b> — a share of everything
            </Toggle>
            {qs?.inferred && (
              <span className="dfa-hint-inline">
                cession inferred from the treaty premium over the subject premium — correct it if the real share is known
              </span>
            )}
          </div>
          {qs && (
            <>
              <div className="dfa-fields dfa-fields-row">
                <NumberField label="Cession %" min="0" max="90" value={qs.cession_pct} onChange={(v) => setQs({ cession_pct: v })} ariaLabel="Quota share cession %" />
                <NumberField
                  label={qs.sliding ? 'Provisional commission %' : 'Commission %'} min="0" max="50"
                  value={qs.commission_pct} onChange={(v) => setQs({ commission_pct: v })} ariaLabel="Quota share commission %"
                />
                <NumberField
                  label={`Event limit${ccy ? ` (${ccy})` : ''}`} min="0" placeholder="none"
                  title="Caps what the quota share cedes on one event; the excess stays with the cedant and feeds the excess-of-loss layers."
                  value={qs.event_limit} onChange={(v) => setQs({ event_limit: v })} ariaLabel="Quota share event limit"
                />
              </div>
              <div className="dfa-subblock">
                <Toggle checked={qs.sliding} onChange={(on) => setQs({ sliding: on })} title="The commission moves with the treaty loss ratio: more when the year is good, less when it is bad.">
                  Sliding-scale commission
                </Toggle>
                {qs.sliding && (
                  <div className="dfa-fields dfa-fields-row">
                    <NumberField label="Min commission %" min="0" max="50" value={qs.sliding_scale.min_pct} onChange={(v) => setSliding({ min_pct: v })} />
                    <NumberField label="Max commission %" min="0" max="50" value={qs.sliding_scale.max_pct} onChange={(v) => setSliding({ max_pct: v })} />
                    <NumberField label="Max at loss ratio ≤ %" min="0" value={qs.sliding_scale.min_lr_pct} onChange={(v) => setSliding({ min_lr_pct: v })} />
                    <NumberField label="Min at loss ratio ≥ %" min="0" value={qs.sliding_scale.max_lr_pct} onChange={(v) => setSliding({ max_lr_pct: v })} />
                  </div>
                )}
                <Toggle checked={qs.corridor} onChange={(on) => setQs({ corridor: on })} title="Inside a band of loss ratios the cedant takes a share of the losses back.">
                  Loss corridor
                </Toggle>
                {qs.corridor && (
                  <div className="dfa-fields dfa-fields-row">
                    <NumberField label="From loss ratio %" min="0" value={qs.loss_corridor.from_lr_pct} onChange={(v) => setCorridor({ from_lr_pct: v })} />
                    <NumberField label="To loss ratio %" min="0" value={qs.loss_corridor.to_lr_pct} onChange={(v) => setCorridor({ to_lr_pct: v })} />
                    <NumberField label="Cedant’s share in the band %" min="0" max="100" value={qs.loss_corridor.cedant_share_pct} onChange={(v) => setCorridor({ cedant_share_pct: v })} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="dfa-block">
          <div className="dfa-block-head">
            <Toggle
              checked={!!sp}
              testid={`${testid}-surplus`}
              onChange={(on) => onChange((s) => ({
                ...s,
                surplus: on
                  ? {
                    ...DEFAULT_SURPLUS,
                    // A line to start from: the first layer's attachment, else 2% of the premium.
                    retained_line: s.xol_layers.find((l) => num(l.attachment) > 0)?.attachment || (num(subjectPremium) > 0 ? Math.round(num(subjectPremium) * 0.02) : ''),
                  }
                  : null,
              }))}
              title="The cedant keeps one line of every risk and cedes the part above it, up to a number of lines: big risks cede more, small ones nothing. Responds after the quota share; reads the risk profile on 01 Scope."
            >
              <b>Surplus</b> — a share of each risk above the retained line
            </Toggle>
          </div>
          {sp && (
            <>
              <div className="dfa-fields dfa-fields-row">
                <NumberField label={`Retained line${ccy ? ` (${ccy})` : ''}`} min="0" value={sp.retained_line} onChange={(v) => setSp({ retained_line: v })} ariaLabel="Surplus retained line" title="The sum insured the cedant keeps of every risk." testid={`${testid}-surplus-line`} />
                <NumberField label="Lines" min="1" max="50" step="1" value={sp.lines} onChange={(v) => setSp({ lines: v })} ariaLabel="Surplus lines" title="How many lines of the retained line the treaty cedes: a risk of (lines + 1) × the line is fully covered." />
                <NumberField label="Commission %" min="0" max="50" value={sp.commission_pct} onChange={(v) => setSp({ commission_pct: v })} ariaLabel="Surplus commission %" />
                <NumberField label={`Event limit${ccy ? ` (${ccy})` : ''}`} min="0" placeholder="none" value={sp.event_limit} onChange={(v) => setSp({ event_limit: v })} ariaLabel="Surplus event limit" title="Caps what the surplus cedes on one event across the risks it hits." />
              </div>
              {profileNote && <span className="dfa-hint-inline">{profileNote}</span>}
            </>
          )}
        </div>

        <div className="dfa-block">
          <div className="dfa-block-head">
            <span className="dfa-block-title"><b>Excess-of-loss layers</b> — each pays the part of one event above its attachment</span>
            <span className="sechead-actions">
              <Toggle checked={detail} onChange={setDetail} title="Reinstatement premium, the share placed and the annual aggregate deductible.">
                <span className="small">Reinstatement, placing &amp; deductible</span>
              </Toggle>
              <button type="button" className="btn btn-secondary btn-sm" onClick={addLayer} data-testid={`${testid}-add`}>+ Add layer</button>
            </span>
          </div>
          <div className="table-wrap dfa-layers-wrap">
            <table className="table dfa-layers">
              <thead>
                <tr>
                  <th>Layer</th>
                  <th className="r" title={LAYER_TITLES.limit}>Limit</th>
                  <th className="r" title={LAYER_TITLES.attachment}>xs Attachment</th>
                  <th className="r" title={LAYER_TITLES.premium}>Premium{ccy ? ` (${ccy})` : ''}</th>
                  <th title={LAYER_TITLES.reinstatements}>Reinstatements</th>
                  {detail && <th className="r" title={LAYER_TITLES.rip}>Reinst. premium %</th>}
                  {detail && <th className="r" title={LAYER_TITLES.placed}>Placed %</th>}
                  {detail && <th className="r" title={LAYER_TITLES.aad}>Annual deductible</th>}
                  <th><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {value.xol_layers.map((l) => (
                  <tr key={l._key}>
                    <td>
                      <input
                        className="input" value={l.name} placeholder="name" aria-label="Layer name"
                        onChange={(e) => setLayer(l._key, { name: e.target.value })}
                      />
                    </td>
                    <td className="r">
                      <input
                        className="input r" type="number" min="0" value={l.limit} aria-label={`${nameOf(l)} limit`}
                        onChange={(e) => setLayer(l._key, { limit: numIn(e.target.value) })}
                      />
                    </td>
                    <td className="r">
                      <input
                        className="input r" type="number" min="0" value={l.attachment} aria-label={`${nameOf(l)} attachment`}
                        onChange={(e) => setLayer(l._key, { attachment: numIn(e.target.value) })}
                      />
                    </td>
                    <td className="r">
                      <input
                        className="input r" type="number" min="0" value={l.premium100} placeholder="model prices it"
                        aria-label={`${nameOf(l)} premium`} title={LAYER_TITLES.premium}
                        onChange={(e) => setLayer(l._key, { premium100: numIn(e.target.value) })}
                      />
                    </td>
                    <td>
                      <select
                        className="input" value={l.reinstatements} aria-label={`${nameOf(l)} reinstatements`}
                        onChange={(e) => setLayer(l._key, { reinstatements: e.target.value })}
                      >
                        {REINSTATEMENT_OPTIONS.map((o) => <option key={o} value={o}>{o === 'UNLIMITED' ? '∞ unlimited' : o}</option>)}
                      </select>
                    </td>
                    {detail && (
                      <td className="r">
                        <input
                          className="input r" type="number" min="0" max="200" value={l.reinstatement_pct} aria-label={`${nameOf(l)} reinstatement premium %`}
                          onChange={(e) => setLayer(l._key, { reinstatement_pct: numIn(e.target.value) })}
                        />
                      </td>
                    )}
                    {detail && (
                      <td className="r">
                        <input
                          className="input r" type="number" min="0" max="100" value={l.placed_pct} aria-label={`${nameOf(l)} placed %`}
                          onChange={(e) => setLayer(l._key, { placed_pct: numIn(e.target.value) })}
                        />
                      </td>
                    )}
                    {detail && (
                      <td className="r">
                        <input
                          className="input r" type="number" min="0" value={l.aggregate_deductible} aria-label={`${nameOf(l)} annual aggregate deductible`}
                          onChange={(e) => setLayer(l._key, { aggregate_deductible: numIn(e.target.value) })}
                        />
                      </td>
                    )}
                    <td className="r">
                      <button
                        type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${nameOf(l)}`} title="Remove this layer"
                        onClick={() => dropLayer(l._key)}
                      >×</button>
                    </td>
                  </tr>
                ))}
                {value.xol_layers.length === 0 && (
                  <tr><td colSpan={detail ? 9 : 6} className="muted">No excess-of-loss layers. Add one to protect the retained account against single large events.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="dfa-block">
          <div className="dfa-block-head">
            <Toggle
              checked={!!agg}
              testid={`${testid}-agg`}
              onChange={(on) => onChange((s) => ({ ...s, aggregate: on ? { ...DEFAULT_AGGREGATE } : null }))}
              title="An aggregate excess of loss on the whole year’s net retained losses, in loss-ratio terms on the premium kept after the quota share."
            >
              <b>Stop loss on what is kept</b> — protects the year, not the event
            </Toggle>
          </div>
          {agg && (
            <div className="dfa-fields dfa-fields-row">
              <NumberField label="Attaches at loss ratio %" min="0" value={agg.attachment_lr_pct} onChange={(v) => setAgg({ attachment_lr_pct: v })} title="Loss ratio on the premium retained after the quota share." />
              <NumberField label="Exhausts at loss ratio %" min="0" value={agg.exhaust_lr_pct} onChange={(v) => setAgg({ exhaust_lr_pct: v })} />
              <NumberField label={`Premium${ccy ? ` (${ccy})` : ''}`} min="0" placeholder="model prices it" value={agg.premium100} onChange={(v) => setAgg({ premium100: v })} title={LAYER_TITLES.premium} />
              <NumberField label="Placed %" min="0" max="100" value={agg.placed_pct} onChange={(v) => setAgg({ placed_pct: v })} />
            </div>
          )}
        </div>
        {children}
      </div>
    </Section>
  );
}

export default function ProgrammeTab({ shared }) {
  const { portfolio, mode, current, setCurrent, proposed, setProposed, ccy, scan, setScan, cal, results } = shared;
  if (!portfolio) return <div className="muted small">Reading the book…</div>;
  if (!current || !proposed) {
    return (
      <div className="blueprint dfa-panel">
        <p className="dfa-lede">There is no book to carry a programme yet — choose what to model on 01 Scope.</p>
      </div>
    );
  }
  const selectedCount = mode === 'portfolio' ? (portfolio.selected?.length || 0) : 1;
  const standalone = mode === 'standalone';
  // One scale for both towers, so a change in the programme is visible as a change in the picture.
  const top = Math.max(
    1,
    ...[...current.xol_layers, ...proposed.xol_layers].map((l) => num(l.attachment) + num(l.limit)),
  );
  const seedKey = (portfolio.selected || []).join(',');
  const subjectPremium = num(cal?.subject_premium);
  const profileNote = cal?.risk_profile?.length
    ? `reads the ${cal.risk_profile.length}-band risk profile on 01 Scope`
    : 'reads the risk profile assumed on 01 Scope — type the book’s own for a true reading';
  const cessionNote = (which) => {
    const sp = results?.structures?.[which]?.structure?.surplus;
    return sp ? `${profileNote} · average cession ${sp.average_cession_pct}% at the last run` : profileNote;
  };

  return (
    <>
      {selectedCount > 1 && (
        <div className="dfa-warn">
          Layers from {selectedCount} placements, each responding to portfolio-wide events — an
          approximation of a multi-programme book. Narrow the selection on 01 Scope to read one programme.
        </div>
      )}
      <div className="dfa-grid dfa-grid-programme">
        <StructurePanel
          key={`cur-${seedKey}`}
          testid="dfa-current"
          title="Current programme"
          kicker={standalone ? 'the programme in force, if any' : 'as the placements carry it'}
          lede={standalone
            ? 'The baseline. Build the programme in force here, priced as quoted — or leave it empty to measure the proposal against running gross.'
            : 'The baseline: the covers already on the book, priced as quoted. Correct anything the record has wrong — the proposed programme is measured against this.'}
          value={current}
          onChange={setCurrent}
          ccy={ccy}
          top={top}
          subjectPremium={subjectPremium}
          profileNote={cessionNote('current')}
        />
        <StructurePanel
          key={`prop-${seedKey}`}
          testid="dfa-proposed"
          title="Proposed programme"
          kicker="the what-if"
          lede="Move a retention, add or drop a layer, try a quota share or a stop loss. Every change is priced against the same simulated years as the current programme."
          value={proposed}
          onChange={setProposed}
          ccy={ccy}
          top={top}
          subjectPremium={subjectPremium}
          profileNote={cessionNote('proposed')}
          actions={(
            <button
              type="button" className="btn btn-secondary btn-sm" data-testid="dfa-reset-proposed"
              onClick={() => setProposed(() => cloneStructure(current))}
            >
              Start again from current
            </button>
          )}
        >
          <div className="dfa-block dfa-explore">
            <label className="field">
              <span>Also explore</span>
              <select className="input" value={scan} onChange={(e) => setScan(e.target.value)} data-testid="dfa-scan">
                {SCAN_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>
            <Note>
              Traces up to six variants of the proposed programme along one dimension, plotted
              on the risk-against-return chart on 04 Impact.
            </Note>
          </div>
        </StructurePanel>
      </div>
      <Note>
        Reading the towers: {fmtCompact(top)} at the top of both, the retention underneath the first
        layer, a quota share as the band on the left. A layer the model prices (no premium keyed)
        shows a dashed edge; a partly placed layer shows paler.{' '}
        {ccy ? `All figures in ${ccy}, ` : 'All figures '}at 100% of the programme.
      </Note>
    </>
  );
}

