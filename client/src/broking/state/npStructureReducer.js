// npStructureReducer — the Structure screen's state. The layer maths is the
// Universe structureReducer (deductible cascade, Earned Premium / ROL / MDP%,
// Excel paste, add / delete) called VERBATIM through its own action types; this
// wrapper adds the programme strip (Deductible = layer-1 attachment, Est. GNPI =
// default EGNPI), the RISK / CAT cover lock, the 20-layer cap and hydration.
import { structureReducer, initialStructureState, fullRecalc, applyTreatyModeCovers } from '../../screens/non_proportional/structure/state/structureReducer';
import { toNum } from '../../screens/non_proportional/structure/NpStructureHelpers';
import { MAX_LAYERS, programmeFromBundle, layersFromBundle } from '../lib/npSlice';
import { perilModeFromTreatyType } from '../../../../shared/broking/calcs.js';

export { MAX_LAYERS };

export const initialNpStructureState = {
  ...initialStructureState,
  programme: { deductible: '', xlType: '', accountingMethod: '', accounts: '', estGnpi: '', brokeragePct: '', taxesPct: '', noClaimsBonusPct: '', profitCommissionPct: '' },
  mode: 'BOTH',
  typeName: '',
  dirty: false,
  hydrated: false,
};

const fillEgnpi = (layers, estGnpi) => (toNum(estGnpi) > 0 ? layers.map((l) => (String(l.egnpi ?? '').trim() ? l : { ...l, egnpi: String(toNum(estGnpi)) })) : layers);

/** Build the initial state from a contract bundle (Universe load: covers locked by treaty type, then a full recalc). */
export function hydrateFromBundle(bundle) {
  const typeName = bundle?.header?.treatyTypeName || '';
  const mode = perilModeFromTreatyType(typeName);
  const programme = programmeFromBundle(bundle);
  const layers = fullRecalc(applyTreatyModeCovers(fillEgnpi(layersFromBundle(bundle), programme.estGnpi), mode), programme.deductible);
  return { ...initialNpStructureState, programme, mode, typeName, layers, dirty: false, hydrated: true };
}

export function npStructureReducer(state, action) {
  switch (action.type) {
    case 'hydrate':
      return hydrateFromBundle(action.bundle);

    case 'programme/edited': {
      const programme = { ...state.programme, [action.key]: action.value };
      let layers = state.layers;
      if (action.key === 'deductible') layers = fullRecalc(layers, action.value);              // re-cascade every attachment
      if (action.key === 'estGnpi') layers = fullRecalc(fillEgnpi(layers, action.value), programme.deductible);
      return { ...state, programme, layers, dirty: true };
    }

    case 'layer/fieldEdited': {
      const next = structureReducer(state, { type: 'layer/fieldEdited', idx: action.idx, field: action.field, value: action.value, baseDeductible: state.programme.deductible });
      return { ...next, layers: applyTreatyModeCovers(next.layers, state.mode), dirty: true };
    }
    case 'layer/pasted': {
      const next = structureReducer(state, { type: 'layer/pasted', startRow: action.startRow, field: action.field, matrix: action.matrix, baseDeductible: state.programme.deductible });
      return { ...next, dirty: true };
    }
    case 'layer/added': {
      if (state.layers.length >= MAX_LAYERS) return state;
      const next = structureReducer(state, { type: 'layer/added', baseDeductible: state.programme.deductible });
      const layers = fullRecalc(applyTreatyModeCovers(fillEgnpi(next.layers, state.programme.estGnpi), state.mode), state.programme.deductible);
      return { ...next, layers, dirty: true };
    }
    case 'layer/lastDeleted': {
      if (state.layers.length <= 1) return state;
      const next = structureReducer(state, { type: 'layer/lastDeleted', baseDeductible: state.programme.deductible });
      return { ...next, dirty: true };
    }
    case 'clean':
      return { ...state, dirty: false };
    default:
      return state;
  }
}
