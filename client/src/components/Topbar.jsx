// App top bar: name, primary navigation (broking only when the flag is on),
// theme switcher, user + sign-out. Styled with the design system's ab- classes.
import { useNavigate, NavLink } from 'react-router-dom';
import ThemeSwitcher from './ThemeSwitcher';
import { useAppState } from '../context/AppContext';
import { api, clearClientRefCache } from '../api';

export default function Topbar() {
  const navigate = useNavigate();
  const { session, signOut, brokingEnabled } = useAppState();
  async function logout() {
    try { await api.logout(); } catch { /* clear locally regardless */ }
    clearClientRefCache();
    signOut();
    navigate('/login');
  }
  return (
    <header className="ab-topbar" role="banner">
      <div className="ab-topbar-left">
        <span className="ab-logo" aria-hidden="true">AB</span>
        <span className="ab-topbar-title">Afro_Asian_Business_Intelligence</span>
        <nav className="ab-topnav" aria-label="Primary">
          <NavLink to="/" end className={({ isActive }) => `ab-topnav-link${isActive ? ' is-active' : ''}`}>Home</NavLink>
          {brokingEnabled && (
            <NavLink to="/broking" className={({ isActive }) => `ab-topnav-link${isActive ? ' is-active' : ''}`}>Broking</NavLink>
          )}
        </nav>
      </div>
      <div className="ab-topbar-right">
        <ThemeSwitcher compact />
        {session && <span className="ab-topbar-user">{session.displayName}</span>}
        {session && <button type="button" className="ab-btn ghost sm" onClick={logout}>Sign out</button>}
      </div>
    </header>
  );
}
