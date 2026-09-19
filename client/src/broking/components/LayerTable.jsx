// LayerTable — the Universe TREATY STRUCTURE – LAYERS card (LayerTableCard.jsx)
// on the design-system table: 16 columns, sticky LAYER column, derived cells
// dashed and not tabbable, REINSTATEMENT_OPTIONS, AAD Amount only when AAD,
// Risk / Cat forced in RISK or CAT mode, a totals row, + Add Layer (max 20),
// Delete Layer (min 1), arrow-key navigation and Excel multi-cell paste.
import Pane from './Pane';
import Button from './Button';
import { MoneyCell, RateCell, PctCell, DerivedCell, SelectCell, CheckCell } from './LayerCells';
import { REINSTATEMENT_OPTIONS } from '../../screens/non_proportional/reinstatementOptions';
import { parseClipboard } from '../../screens/non_proportional/structure/NpStructureHelpers';
import { gridKeyDown } from '../lib/gridNav';
import { MAX_LAYERS } from '../lib/npSlice';
import { layerTotals } from '../../../../shared/broking/calcs.js';

export function TypePills({ mode }) {
  const risk = mode === 'RISK' || mode === 'BOTH'; const cat = mode === 'CAT' || mode === 'BOTH';
  return (
    <span className="ab-type-pills" aria-label="Treaty type">
      <span className={risk ? 'ab-badge success' : 'ab-tag'} data-testid="pill-risk" data-on={risk}>RISK XL</span>
      <span className={cat ? 'ab-badge success' : 'ab-tag'} data-testid="pill-cat" data-on={cat}>CAT XL</span>
    </span>
  );
}

export function LayerActions({ count, onAdd, onDelete }) {
  return (
    <>
      <Button size="sm" onClick={onAdd} disabled={count >= MAX_LAYERS} data-testid="add-layer">+ Add Layer</Button>
      <Button size="sm" onClick={onDelete} disabled={count <= 1} data-testid="delete-layer">Delete Layer</Button>
    </>
  );
}

/** Universe handleLayerPaste: a multi-cell clipboard fills across PASTE_FIELD_ORDER from the target cell. */
export function layerPasteHandler(onPaste) {
  return (e) => {
    const target = e.target;
    const tr = target?.closest?.('tr[data-layer-row]');
    const field = target?.getAttribute?.('data-paste-field');
    if (!tr || !field) return;
    const startRow = Number(tr.getAttribute('data-layer-row'));
    const matrix = parseClipboard(e.clipboardData?.getData('text') ?? '');
    if (matrix.length <= 1 && (!matrix[0] || matrix[0].length <= 1)) return;    // single cell = normal paste
    e.preventDefault();
    onPaste(startRow, field, matrix);
  };
}

export default function LayerTable({ layers, mode, currency, onUpdateLayer, onAddLayer, onDeleteLastLayer, onPaste }) {
  const locked = mode !== 'BOTH';
  const totals = layerTotals(layers);
  const cur = currency ? ` · ${currency}` : '';
  return (
    <Pane title="Treaty structure – layers" className="ab-layers-pane" headRight={(
      <span className="ab-table-bar"><span className="ab-tag">{layers.length} layer{layers.length === 1 ? '' : 's'}</span><LayerActions count={layers.length} onAdd={onAddLayer} onDelete={onDeleteLastLayer} /></span>
    )}>
      <div className="ab-table-wrap">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys and Excel paste are enhancements over the native cell inputs */}
        <table className="ab-table ab-layer-table" aria-label="Layers" onKeyDown={gridKeyDown} onPaste={layerPasteHandler(onPaste)}>
          <thead>
            <tr>
              <th className="ab-sticky">Layer</th><th>Limit{cur}</th><th>Deductible / attachment</th><th>Aggregate limit</th><th>EGNPI</th>
              <th title="RATE = Earned Premium ÷ EGNPI (expressed as %). Enter e.g. 2.5 for 2.5% — NOT 0.025.">Rate %</th>
              <th>Earned premium</th><th>MDP</th><th>MDP%</th><th>No. reinst.</th><th>% reinst.</th><th>AAD</th><th>AAD amount</th><th>Risk</th><th>Cat</th>
              <th title="ROL = Earned Premium ÷ Limit (Rate-on-Line, %). Auto-computed — not editable.">ROL</th>
            </tr>
          </thead>
          <tbody>
            {layers.map((l, i) => (
              <tr key={i} data-layer-row={i} data-testid={`layer-row-${i + 1}`}>
                <td className="ab-sticky">{l.layer}</td>
                <td><MoneyCell value={l.limit} onChange={(v) => onUpdateLayer(i, 'limit', v)} pasteField="limit" label={`Layer ${i + 1} limit`} /></td>
                <td><DerivedCell value={l.deductible} label={`Layer ${i + 1} deductible`} /></td>
                <td><MoneyCell value={l.annualAggLimit} onChange={(v) => onUpdateLayer(i, 'annualAggLimit', v)} pasteField="annualAggLimit" label={`Layer ${i + 1} aggregate limit`} /></td>
                <td><MoneyCell value={l.egnpi} onChange={(v) => onUpdateLayer(i, 'egnpi', v)} pasteField="egnpi" label={`Layer ${i + 1} EGNPI`} /></td>
                <td><RateCell value={l.rate} onChange={(v) => onUpdateLayer(i, 'rate', v)} pasteField="rate" label={`Layer ${i + 1} rate`} /></td>
                <td><DerivedCell value={l.earnedPremium} label={`Layer ${i + 1} earned premium`} /></td>
                <td><MoneyCell value={l.mdp} onChange={(v) => onUpdateLayer(i, 'mdp', v)} pasteField="mdp" label={`Layer ${i + 1} MDP`} /></td>
                <td><DerivedCell kind="text" value={l.mdpPct} small label={`Layer ${i + 1} MDP%`} /></td>
                <td><SelectCell value={l.reinstatements} onChange={(v) => onUpdateLayer(i, 'reinstatements', v)} options={REINSTATEMENT_OPTIONS} label={`Layer ${i + 1} reinstatements`} /></td>
                <td><PctCell value={l.reinstatementPct} onChange={(v) => onUpdateLayer(i, 'reinstatementPct', v)} max={1000} pasteField="reinstatementPct" label={`Layer ${i + 1} reinstatement %`} /></td>
                <td className="ab-center"><CheckCell checked={l.aad} onChange={(v) => onUpdateLayer(i, 'aad', v)} label={`Layer ${i + 1} AAD`} /></td>
                <td><MoneyCell value={l.aadAmount} onChange={(v) => onUpdateLayer(i, 'aadAmount', v)} disabled={!l.aad} pasteField="aadAmount" label={`Layer ${i + 1} AAD amount`} /></td>
                <td className={`ab-center${locked ? ' is-locked' : ''}`}><CheckCell checked={l.riskCover} onChange={(v) => onUpdateLayer(i, 'riskCover', v)} disabled={locked} label={`Layer ${i + 1} risk`} /></td>
                <td className={`ab-center${locked ? ' is-locked' : ''}`}><CheckCell checked={l.catCover} onChange={(v) => onUpdateLayer(i, 'catCover', v)} disabled={locked} label={`Layer ${i + 1} cat`} /></td>
                <td><DerivedCell kind="text" value={l.rol} small label={`Layer ${i + 1} ROL`} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-testid="layer-totals">
              <td className="ab-sticky">Σ</td>
              <td data-col="limit">{fmt(totals.limit)}</td><td data-col="deductible">{fmt(totals.deductible)}</td><td data-col="aggregateLimit">{fmt(totals.aggregateLimit)}</td>
              <td data-col="egnpi">{fmt(totals.egnpi)}</td><td data-col="rate">{totals.rate != null ? `${totals.rate}%` : ''}</td><td data-col="earnedPremium">{fmt(totals.earnedPremium)}</td>
              <td data-col="mdp">{fmt(totals.mdp)}</td><td data-col="mdpPct">{pct(totals.mdpPct)}</td><td data-col="reinstatements">{totals.reinstatements ?? ''}</td>
              <td /><td /><td /><td /><td /><td data-col="rol">{pct(totals.rol)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="ab-help" style={{ marginTop: 10 }}>Enter <b>Rate</b> to calculate <b>Earned Premium = EGNPI × Rate</b>. <b>ROL</b> is implied as <b>Earned Premium ÷ Limit</b>. <b>MDP%</b> is implied as <b>MDP ÷ Earned Premium</b>. Layer 1 deductible is the programme Deductible; subsequent deductibles auto-calculate as <b>prior deductible + prior limit</b>. Paste a block of cells from Excel to fill Limit, Aggregate limit, EGNPI, Rate, MDP, % reinst. and AAD amount across.</p>
    </Pane>
  );
}

function fmt(n) { return n == null ? '' : Math.round(n).toLocaleString('en-US'); }
function pct(f) { if (f == null) return ''; const v = f * 100; return `${v.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`; }
