import React from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { RoleProvider, HeaderProvider, useHeader } from './shell.jsx';
import { fmtDate } from './components.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import TopBar from './TopBar.jsx';
import Login from './views/Login.jsx';
// The hub, and the four functions the tool keeps.
import Dashboard from './views/Dashboard.jsx';
import RenewalCalendar from './views/RenewalCalendar.jsx';
import PortfolioIntelligence from './views/PortfolioIntelligence.jsx';
import ProgrammeAnalysis from './views/ProgrammeAnalysis.jsx';
import MarketIntelligence from './views/MarketIntelligence.jsx';
import ContractsHome from './views/contracts/ContractsHome.jsx';
import PropTreatyDetail from './views/contracts/PropTreatyDetail.jsx';
import NpContractDetails from './views/contracts/NpContractDetails.jsx';
import ContractRoute, { PlacementRedirect } from './views/contracts/ContractRoute.jsx';
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
  // No primary rail: the dashboard is the hub — its launcher lists the
  // four destinations — and Home in the top bar brings it back from any
  // page. The shell is one full-width column under the top bar, whose
  // account menu carries the "acting as" lens, the theme and sign-out.
  return (
    <div className="shell">
      <div className="main">
        <TopBar />
        <ScreenHead />
        <ErrorBoundary resetKey={location.pathname}>
          <Routes>
            {/* The hub. */}
            <Route path="/" element={<Dashboard />} />
            {/* Reached from the top bar's renewal-calendar button and the launcher. */}
            <Route path="/renewals" element={<RenewalCalendar />} />
            {/* Its neighbour in the top bar: the book by who leads, places and writes it. */}
            <Route path="/portfolio" element={<PortfolioIntelligence />} />
            {/* Its "Analyse programmes" button: the same book by broker and by reinsurer, in charts. */}
            <Route path="/portfolio/programmes" element={<ProgrammeAnalysis />} />
            {/* Market intelligence: a market by country or region — our book
                there, the AI's research of the internet, the brokers' visits and notes. */}
            <Route path="/portfolio/market-intelligence" element={<MarketIntelligence />} />

            {/* Contracts: two options. Proportional opens the Universe treaty
                detail; non-proportional the contract details pane of the NP
                treaty detail. Keyed on the id so a save that lands on the
                contract's own URL remounts with the saved record. */}
            <Route path="/contracts" element={<ContractsHome />} />
            <Route path="/contracts/proportional" element={<PropTreatyDetail key="new" />} />
            <Route path="/contracts/proportional/:id" element={<KeyedByParam Screen={PropTreatyDetail} />} />
            <Route path="/contracts/non-proportional" element={<NpContractDetails key="new" />} />
            <Route path="/contracts/non-proportional/:id" element={<KeyedByParam Screen={NpContractDetails} />} />
            {/* A contract by id opens on its basis page; the placement page's
                old address still lands there. */}
            <Route path="/contracts/:id" element={<ContractRoute />} />
            <Route path="/placements/:id" element={<PlacementRedirect />} />

            {canOversee && <Route path="/admin" element={<Admin />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </div>
    </div>
  );
}

/** Remount a screen when its :id changes. */
function KeyedByParam({ Screen }) {
  const { id } = useParams();
  return <Screen key={id} />;
}

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return null;
  if (!user) return <Login />;

  return (
    // The Treaty Detail reference lists load once per sign-in, for every dropdown.
    <RefDataProvider>
      <RoleProvider>
        <HeaderProvider>
          <ToastProvider>
            <Shell />
          </ToastProvider>
        </HeaderProvider>
      </RoleProvider>
    </RefDataProvider>
  );
}
