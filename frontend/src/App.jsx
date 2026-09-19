import React from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { WorkspaceProvider, RoleProvider, HeaderProvider, useHeader } from './shell.jsx';
import { fmtDate } from './components.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import TopBar from './TopBar.jsx';
import Login from './views/Login.jsx';
// The six designed screens.
import Dashboard from './views/Dashboard.jsx';
import RenewalCalendar from './views/RenewalCalendar.jsx';
import PortfolioIntelligence from './views/PortfolioIntelligence.jsx';
import ProgrammeAnalysis from './views/ProgrammeAnalysis.jsx';
import MarketIntelligence from './views/MarketIntelligence.jsx';
import RenewalPack from './views/RenewalPack.jsx';
import RenewalAnalysis from './views/RenewalAnalysis.jsx';
import RenewalAnalysisDetail from './views/RenewalAnalysisDetail.jsx';
import LayerWorkspace from './views/LayerWorkspace.jsx';
import Signing from './views/Signing.jsx';
import SigningWorksheet from './views/SigningWorksheet.jsx';
import WordingLibrary from './views/WordingLibrary.jsx';
import ClaimsPremiums from './views/ClaimsPremiums.jsx';
import ClaimsPremiumDashboard, { ServicingEntry, ProportionalServicing, ServicingWorkflow } from './views/ClaimsPremiumDashboard.jsx';
import DFA from './views/DFA.jsx';
import PremiumWorkspace from './views/PremiumWorkspace.jsx';
import ClaimsWorkspace from './views/ClaimsWorkspace.jsx';
// Operational surfaces: the market-facing input paths and the register.
import LayerOperations from './views/LayerOperations.jsx';
import Placements from './views/Placements.jsx';
import PlacementDetail from './views/PlacementDetail.jsx';
import Markets from './views/Markets.jsx';
import MarketDetail from './views/MarketDetail.jsx';
import Cedants from './views/Cedants.jsx';
import Contracts from './views/Contracts.jsx';
import YearWorkspace from './views/spine/YearWorkspace.jsx';
import Wordings from './views/Wordings.jsx';
import WordingDraft from './views/WordingDraft.jsx';
import Admin from './views/Admin.jsx';
import { RefDataProvider } from './RefData.jsx';
import { ToastProvider } from './toast.jsx';

function ScreenHead() {
  const { head } = useHeader();
  if (!head.title) return null;
  return (
    <header className="screen-head">
      <div>
        <div className="crumb">{head.crumb}</div>
        <h2 className="screen-title">{head.title}</h2>
      </div>
      <div className="head-right">
        {head.tag && <span className="head-tag">{head.tag}</span>}
        <span className="asat">as at {fmtDate(new Date().toISOString())}</span>
      </div>
    </header>
  );
}

function Shell() {
  const { user } = useAuth();
  const location = useLocation();
  const canOversee = ['admin', 'underwriter'].includes(user.role);
  // No primary rail: the dashboard is the hub — its launcher lists every
  // destination as two rows of four tiles — and Home in the top bar brings
  // it back from any page. The shell is one full-width column under the
  // top bar, whose account menu carries the "acting as" lens, the theme
  // and sign-out.
  return (
    <div className="shell">
      <div className="main">
        <TopBar />
        <ScreenHead />
        <ErrorBoundary resetKey={location.pathname}>
          <Routes>
            {/* The designed screens */}
            <Route path="/" element={<Dashboard />} />
            {/* Reached from the top bar's renewal-calendar button. */}
            <Route path="/renewals" element={<RenewalCalendar />} />
            {/* Its neighbour in the top bar: the book by who leads, places and writes it. */}
            <Route path="/portfolio" element={<PortfolioIntelligence />} />
            {/* Its "Analyse programmes" button: the same book by broker and by reinsurer, in charts. */}
            <Route path="/portfolio/programmes" element={<ProgrammeAnalysis />} />
            {/* Its "Market intelligence" button: a market by country or region — our book
                there, the AI's research of the internet, the brokers' visits and notes. */}
            <Route path="/portfolio/market-intelligence" element={<MarketIntelligence />} />
            <Route path="/renewal-packs" element={<RenewalAnalysis />} />
            <Route path="/renewal-packs/:id" element={<RenewalAnalysisDetail />} />
            {/* The screens were /renewal-analysis before §02 became "Renewal
                packs"; keep old links and bookmarks working. */}
            <Route path="/renewal-analysis" element={<Navigate to="/renewal-packs" replace />} />
            <Route path="/renewal-analysis/:id" element={<RenewalAnalysisRedirect />} />
            <Route path="/placements/:id/pack" element={<RenewalPack />} />
            <Route path="/layers/:id" element={<LayerWorkspace />} />
            {/* Signing opens on a question — which contract? — then shows its
                programme and its signings; the worksheet is one layer's arithmetic. */}
            <Route path="/signing" element={<Signing />} />
            <Route path="/signing/:id" element={<Signing />} />
            <Route path="/layers/:id/signing" element={<SigningWorksheet />} />
            <Route path="/wording" element={<WordingLibrary />} />
            <Route path="/claims-premiums" element={<ServicingEntry />} />
            <Route path="/claims-premiums/non-proportional" element={<ClaimsPremiumDashboard />} />
            <Route path="/claims-premiums/non-proportional/premium" element={<PremiumWorkspace />} />
            <Route path="/claims-premiums/non-proportional/claims" element={<ClaimsWorkspace />} />
            <Route path="/claims-premiums/non-proportional/:workflow" element={<ServicingWorkflow />} />
            <Route path="/claims-premiums/proportional" element={<ProportionalServicing />} />
            <Route path="/placements/:id/claims" element={<ClaimsPremiums />} />
            {/* Dynamic financial analysis — reached from the dashboard hero. */}
            <Route path="/dfa" element={<DFA />} />

            {/* Operational surfaces */}
            <Route path="/layers/:id/operations" element={<LayerOperations />} />
            <Route path="/contracts" element={<Contracts />} />
            <Route path="/contract-years/:id" element={<YearWorkspace />} />
            <Route path="/placements" element={<Placements />} />
            {/* /placements/new is the same screen as a saved placement — the
                full placement page with every section — set up in memory
                until it is created. */}
            <Route path="/placements/:id" element={<PlacementRoute />} />
            <Route path="/markets" element={<Markets />} />
            <Route path="/markets/:id" element={<MarketDetail />} />
            <Route path="/cedants" element={<Cedants />} />
            <Route path="/wordings" element={<Wordings />} />
            <Route path="/wordings/drafts/:id" element={<WordingDraft />} />
            {canOversee && <Route path="/admin" element={<Admin />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </div>
    </div>
  );
}

/** /renewal-analysis/:id → /renewal-packs/:id, keeping the id. */
function RenewalAnalysisRedirect() {
  const { id } = useParams();
  return <Navigate to={`/renewal-packs/${id}`} replace />;
}

/** Keyed on the id so that creating a placement — which lands on its own
    URL — remounts the page with the saved record rather than the draft. */
function PlacementRoute() {
  const { id } = useParams();
  return <PlacementDetail key={id} />;
}

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return null;
  if (!user) return <Login />;

  return (
    // The Treaty Detail reference lists load once per sign-in, for every dropdown.
    <RefDataProvider>
      <RoleProvider>
        <WorkspaceProvider>
          <HeaderProvider>
            <ToastProvider>
              <Shell />
            </ToastProvider>
          </HeaderProvider>
        </WorkspaceProvider>
      </RoleProvider>
    </RefDataProvider>
  );
}

