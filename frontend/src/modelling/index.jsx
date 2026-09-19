import React from 'react';
import { ModellingProvider, useModelling } from './store.jsx';
import { Notice } from './bits.jsx';
import TriangleScreen from './Triangles.jsx';
import NoTriangulation from './NoTriangulation.jsx';
import DevFactorsScreen from './DevFactors.jsx';
import { LossListScreen, LossSelectionScreen } from './Losses.jsx';
import LossParetoScreen from './LossPareto.jsx';
import ProfileScreen from './Profiles.jsx';
import CrestaScreen from './Cresta.jsx';
import EventLossTablesScreen from './EventLossTables.jsx';
import ProjectedSummary from './ProjectedSummary.jsx';
import QuickSummary from './QuickSummary.jsx';
import NpPremiums from './NpPremiums.jsx';
import NpLossDevFactors from './NpLossDevFactors.jsx';
import NpExcessDevFactors from './NpExcessDevFactors.jsx';
import NpHistorical from './NpHistorical.jsx';

export { ModellingProvider, useModelling } from './store.jsx';
export { modellingBasis, modellingBases, primaryBasis, modellingGroups, modellingTabList } from './workflow.js';

/* Tab key → screen. The keys are the "m:"-prefixed entries the workflow
   config hands the placement page. */
const SCREENS = {
  'm:tri_premium': () => <TriangleScreen type="premium" />,
  'm:tri_paid': () => <TriangleScreen type="paid" />,
  'm:tri_os': () => <TriangleScreen type="os" />,
  'm:tri_incurred': () => <TriangleScreen type="incurred" />,
  'm:straight_stats': () => <NoTriangulation />,
  'm:large_list': () => <LossListScreen lossType="large" />,
  'm:large_selection': () => <LossSelectionScreen lossType="large" />,
  'm:large_pareto': () => <LossParetoScreen lossType="large" />,
  'm:cat_list': () => <LossListScreen lossType="cat" />,
  'm:cat_selection': () => <LossSelectionScreen lossType="cat" />,
  'm:cat_pareto': () => <LossParetoScreen lossType="cat" />,
  'm:dev_premium': () => <DevFactorsScreen type="premium" />,
  'm:dev_paid': () => <DevFactorsScreen type="paid" />,
  'm:dev_os': () => <DevFactorsScreen type="os" />,
  'm:dev_incurred': () => <DevFactorsScreen type="incurred" />,
  'm:projected_summary': () => <ProjectedSummary />,
  'm:quick_summary': () => <QuickSummary />,
  'm:risk_profile': () => <ProfileScreen profileType="risk" />,
  'm:claims_profile': () => <ProfileScreen profileType="claims" />,
  'm:cresta': () => <CrestaScreen />,
  'm:event_loss_tables': () => <EventLossTablesScreen />,
  'm:np_premiums': () => <NpPremiums />,
  'm:np_large_ldf': () => <NpLossDevFactors lossType="large" />,
  'm:np_cat_ldf': () => <NpLossDevFactors lossType="cat" />,
  'm:np_excess_dev': () => <NpExcessDevFactors />,
  'm:np_historical': () => <NpHistorical />,
};

function ScreenBody({ tab }) {
  const mod = useModelling();
  if (mod.loading) return <div className="muted" style={{ padding: 20 }}>Loading modelling data…</div>;
  if (mod.error) {
    return (
      <Notice tone="warn">
        Couldn't load the saved modelling data ({mod.error.message || 'server error'}) — editing would risk saving over
        server data, so reload the page before working here.
      </Notice>
    );
  }
  const Render = SCREENS[tab];
  if (!Render) return <Notice tone="warn">Unknown modelling screen "{tab}".</Notice>;
  // Keyed on the class of business, so a switch renders that class's data
  // from a clean screen state.
  return <Render key={mod.activeCob || 'all'} />;
}

export function isModellingTab(tab) {
  return typeof tab === 'string' && tab.startsWith('m:');
}

/** The whole modelling pane: provider + the active screen. */
export default function ModellingPane({ tab }) {
  return <ScreenBody tab={tab} />;
}
