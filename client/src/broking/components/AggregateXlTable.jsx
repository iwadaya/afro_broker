// AggregateXlTable — the Universe NpAggregateXlStructure layer table: per layer
// Aggregate Limit, Aggregate Deductible, Deductible (per loss), AAD, Risk, Cat.
// (The Universe policy-shape toggles and COB inner limits have no columns in the
// AABI data model — see docs/broking/CHANGELOG.md.)
import Pane from './Pane';
import { MoneyCell, CheckCell } from './LayerCells';
import { LayerActions } from './LayerTable';
import { gridKeyDown } from '../lib/gridNav';

export default function AggregateXlTable({ layers, currency, onUpdateLayer, onAddLayer, onDeleteLastLayer }) {
  const cur = currency ? ` (${currency})` : '';
  return (
    <Pane title="Aggregate XL structure · by layer" headRight={<span className="ab-table-bar"><span className="ab-tag">{layers.length} layer{layers.length === 1 ? '' : 's'}</span><LayerActions count={layers.length} onAdd={onAddLayer} onDelete={onDeleteLastLayer} /></span>}>
      <div className="ab-table-wrap">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys are an enhancement over the native cell inputs */}
        <table className="ab-table ab-layer-table" aria-label="Aggregate XL layers" onKeyDown={gridKeyDown}>
          <thead><tr><th className="ab-sticky">Layer</th><th>Aggregate limit{cur}</th><th>Aggregate deductible{cur}</th><th>Deductible{cur}</th><th>AAD{cur}</th><th>Risk</th><th>Cat</th></tr></thead>
          <tbody>
            {layers.map((l, i) => (
              <tr key={i} data-layer-row={i} data-testid={`layer-row-${i + 1}`}>
                <td className="ab-sticky">L{i + 1}</td>
                <td><MoneyCell value={l.annualAggLimit} onChange={(v) => onUpdateLayer(i, 'annualAggLimit', v)} label={`Layer ${i + 1} aggregate limit`} /></td>
                <td><MoneyCell value={l.aggregateDeductible} onChange={(v) => onUpdateLayer(i, 'aggregateDeductible', v)} label={`Layer ${i + 1} aggregate deductible`} /></td>
                <td><MoneyCell value={l.deductible} onChange={(v) => onUpdateLayer(i, 'deductible', v)} label={`Layer ${i + 1} deductible`} /></td>
                <td><MoneyCell value={l.aadAmount} onChange={(v) => onUpdateLayer(i, 'aadAmount', v)} label={`Layer ${i + 1} AAD`} /></td>
                <td className="ab-center"><CheckCell checked={l.riskCover} onChange={(v) => onUpdateLayer(i, 'riskCover', v)} label={`Layer ${i + 1} risk`} /></td>
                <td className="ab-center"><CheckCell checked={l.catCover} onChange={(v) => onUpdateLayer(i, 'catCover', v)} label={`Layer ${i + 1} cat`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ab-help" style={{ marginTop: 10 }}>Aggregate Limit / Deductible apply to the annual aggregate; Deductible and AAD apply per loss.</p>
    </Pane>
  );
}
