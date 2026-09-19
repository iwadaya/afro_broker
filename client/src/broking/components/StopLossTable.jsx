// StopLossTable — the Universe NpStopLossStructure: per layer Attach LR %,
// Limit LR %, EPI, with the resolved limit (EPI × Limit LR %) and attachment
// (EPI × Attach LR %) derived. Layer count via + Add Layer / Delete Layer.
import Pane from './Pane';
import { MoneyCell, PctCell, DerivedCell } from './LayerCells';
import { LayerActions } from './LayerTable';
import { gridKeyDown } from '../lib/gridNav';
import { stopLossResolve } from '../../../../shared/broking/calcs.js';

export default function StopLossTable({ layers, currency, onUpdateLayer, onAddLayer, onDeleteLastLayer }) {
  const cur = currency ? ` (${currency})` : '';
  return (
    <Pane title="Stop loss structure · by layer" headRight={<span className="ab-table-bar"><span className="ab-tag">Loss-ratio basis</span><span className="ab-tag">{layers.length} layer{layers.length === 1 ? '' : 's'}</span><LayerActions count={layers.length} onAdd={onAddLayer} onDelete={onDeleteLastLayer} /></span>}>
      <div className="ab-table-wrap">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys are an enhancement over the native cell inputs */}
        <table className="ab-table ab-layer-table" aria-label="Stop loss layers" onKeyDown={gridKeyDown}>
          <thead><tr><th className="ab-sticky">Layer</th><th>Attach LR %</th><th>Limit LR %</th><th>EPI{cur}</th><th>Resolved · limit</th><th>Resolved · attach</th></tr></thead>
          <tbody>
            {layers.map((l, i) => {
              const r = stopLossResolve({ epi: l.epi, limitLrPct: l.limitLrPct, attachLrPct: l.attachLrPct });
              return (
                <tr key={i} data-layer-row={i} data-testid={`layer-row-${i + 1}`}>
                  <td className="ab-sticky">L{i + 1}</td>
                  <td><PctCell value={l.attachLrPct} onChange={(v) => onUpdateLayer(i, 'attachLrPct', v)} max={1000} label={`Layer ${i + 1} attach LR %`} /></td>
                  <td><PctCell value={l.limitLrPct} onChange={(v) => onUpdateLayer(i, 'limitLrPct', v)} max={1000} label={`Layer ${i + 1} limit LR %`} /></td>
                  <td><MoneyCell value={l.epi} onChange={(v) => onUpdateLayer(i, 'epi', v)} label={`Layer ${i + 1} EPI`} /></td>
                  <td><DerivedCell value={r.limit} label={`Layer ${i + 1} resolved limit`} /></td>
                  <td><DerivedCell value={r.attachment} label={`Layer ${i + 1} resolved attachment`} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="ab-help" style={{ marginTop: 10 }}>Resolved limit = EPI × Limit LR %; resolved attachment = EPI × Attach LR %. Layer 1 is the primary cover.</p>
    </Pane>
  );
}
