import React, { Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider, useAppState } from '../../context/AppContext';
import { ToastProvider } from '../ToastProvider';
import { appRoutes } from '../../routes/appRoutes';

function AuthGuard({ children }) {
  const { session } = useAppState();
  const location = useLocation();
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function BrokingGuard({ children }) {
  const { config, brokingEnabled } = useAppState();
  if (!config) return <div className="ab ab-boot">Loading…</div>;
  if (!brokingEnabled) return <Navigate to="/" replace />;
  return children;
}

class ScreenErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="ab ab-boot" role="alert">
          <p>Something went wrong on this screen: {String(this.state.error?.message || this.state.error)}</p>
          <button type="button" className="ab-btn ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function RoutedBoundary({ children }) {
  const location = useLocation();
  return <ScreenErrorBoundary key={location.pathname}>{children}</ScreenErrorBoundary>;
}

function Fallback() { return <div className="ab ab-boot">Loading…</div>; }

export default function AppShell() {
  return (
    <AppProvider>
      <ToastProvider>
        <Suspense fallback={<Fallback />}>
          <RoutedBoundary>
            <Routes>
              {appRoutes.map(({ path, component: Component, public: isPublic, broking }) => {
                let element = <Component />;
                if (broking) element = <BrokingGuard>{element}</BrokingGuard>;
                if (!isPublic) element = <AuthGuard>{element}</AuthGuard>;
                return <Route key={path} path={path} element={element} />;
              })}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RoutedBoundary>
        </Suspense>
      </ToastProvider>
    </AppProvider>
  );
}
