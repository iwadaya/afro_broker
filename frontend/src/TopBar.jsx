import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ALL_YEARS, TREATY_YEARS, useTreatyYear, yearLabel } from './treatyYear.js';
import { useAuth } from './auth.jsx';
import { ROLE_NOTES, useRole } from './shell.jsx';
import { Avatar } from './components.jsx';
import ThemeSwitcher from './ThemeSwitcher.jsx';
import BrandLockup from './BrandLockup.jsx';

/**
 * The global bar above the screen header: the brand, Home, search, the two
 * book screens, treaty-year context, notifications, recents and the account
 * menu. There is no primary rail — the dashboard is the hub, its launcher
 * lists every destination, and Home brings it back from any page.
 *
 * Search hands off to the contracts register, which owns the query in its
 * URL so a search result is linkable and survives a refresh.
 */
export default function TopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [term, setTerm] = useState('');
  const [year, setYear] = useTreatyYear();
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const recentsRef = useRef(null);
  const accountRef = useRef(null);
  useDismiss(recentsOpen, recentsRef, setRecentsOpen);
  useDismiss(accountOpen, accountRef, setAccountOpen);

  function submit(e) {
    e.preventDefault();
    navigate(`/contracts?q=${encodeURIComponent(term.trim())}`);
  }

  return (
    <div className="topbar">
      <BrandLockup size="topbar" className="topbar-brand" aria-hidden="true" />
      {/* Home: the dashboard — the hub — one click from any page. */}
      <button
        type="button"
        className="topbar-renewals topbar-home"
        title="Home — the dashboard"
        aria-current={location.pathname === '/' ? 'page' : undefined}
        onClick={() => navigate('/')}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 11.5 12 4l8.5 7.5" />
          <path d="M5.5 10v10h13V10" />
          <path d="M10 20v-6h4v6" />
        </svg>
        <span className="topbar-renewals-label">Home</span>
      </button>

      <form className="topbar-search" onSubmit={submit} role="search">
        <span className="topbar-search-icon" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="6.2" /><path d="m16 16 3.6 3.6" strokeLinecap="round" />
          </svg>
        </span>
        <input
          type="search"
          className="input"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search contracts, cedants…"
          aria-label="Search contracts and cedants"
        />
      </form>

      <div className="topbar-tools">
        <button
          type="button"
          className="topbar-renewals"
          title="Renewal calendar — upcoming renewals in the next 3 months"
          onClick={() => navigate('/renewals')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
            <path d="M3.5 9.5h17M8 2.8v4.4M16 2.8v4.4" />
            <path d="M7.5 13.5h3M13.5 13.5h3M7.5 17h3" />
          </svg>
          <span className="topbar-renewals-label">Renewal calendar</span>
        </button>
        {/* Beside the calendar: the book read by who leads, places and writes it. */}
        <button
          type="button"
          className="topbar-renewals topbar-portfolio"
          title="Portfolio intelligence — who leads, who places and who writes the book"
          onClick={() => navigate('/portfolio')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 20.5h16" />
            <path d="M6.5 17V11M11 17V5.5M15.5 17v-4M20 17V8.5" />
          </svg>
          <span className="topbar-renewals-label">Portfolio intelligence</span>
        </button>

        <label className="sr-only" htmlFor="biq-treaty-year">Treaty year</label>
        <select
          id="biq-treaty-year"
          className="input topbar-year"
          value={year}
          onChange={(e) => setYear(e.target.value)}
        >
          {TREATY_YEARS.map((y) => (
            <option key={y} value={y}>
              {y === ALL_YEARS ? yearLabel(y) : `${yearLabel(y)} treaty year`}
            </option>
          ))}
        </select>

        <button type="button" className="iconbtn" aria-label="Notifications" title="Notifications">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.3.9 5 1.7 6H4.8c.8-1 1.7-2.7 1.7-6Z" />
            <path d="M10.2 19.2a2 2 0 0 0 3.6 0" />
          </svg>
          <span className="iconbtn-dot" aria-hidden="true" />
        </button>

        <span className="popover-host" ref={recentsRef}>
          <button
            type="button"
            className="iconbtn"
            aria-label="Recent contracts"
            title="Recent contracts"
            aria-expanded={recentsOpen}
            onClick={() => setRecentsOpen((o) => !o)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="7.7" /><path d="M12 8v4.3l2.7 1.7" />
            </svg>
          </button>
          {recentsOpen && (
            <div className="popover topbar-recents" role="dialog" aria-label="Recent contracts">
              <div className="kicker" style={{ marginBottom: 8 }}>Recent</div>
              <RecentList onPick={() => setRecentsOpen(false)} />
            </div>
          )}
        </span>

        {/* The account menu: who is signed in, the "acting as" lens, the
            theme, Admin for those who oversee, and sign-out — what the
            primary rail used to carry under its destinations. */}
        <span className="popover-host topbar-account-host" ref={accountRef}>
          <button
            type="button"
            className="topbar-account"
            aria-label={`Account — ${user.name}`}
            title="Account — acting as, theme, sign out"
            aria-expanded={accountOpen}
            aria-haspopup="dialog"
            onClick={() => setAccountOpen((o) => !o)}
          >
            <Avatar name={user.name} size="sm" />
            <span className="topbar-account-name">{user.name}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {accountOpen && (
            <div className="popover topbar-account-menu account-menu" role="dialog" aria-label="Account">
              <AccountMenu onDone={() => setAccountOpen(false)} />
            </div>
          )}
        </span>
      </div>
    </div>
  );
}

/** Close a popover on a click outside it or on Esc. */
function useDismiss(open, ref, setOpen) {
  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) { if (!ref.current?.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, setOpen]);
}

function AccountMenu({ onDone }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const role = useRole();
  const canOversee = ['admin', 'underwriter'].includes(user.role);
  return (
    <>
      <div className="account-who">
        <Avatar name={user.name} />
        <span className="account-who-text">
          <span className="account-name">{user.name}</span>
          <span className="account-role">{String(user.role).replace(/_/g, ' ')}</span>
        </span>
      </div>

      <div className="account-section">
        <div className="kicker">Acting as</div>
        <div className="role-switch">
          {['Broker', 'Analyst', 'Underwriter'].map((r) => (
            <button
              key={r}
              type="button"
              className={`rolebtn${role.actingAs === r ? ' active' : ''}`}
              aria-pressed={role.actingAs === r}
              onClick={() => role.setActingAs(r)}
            >{r}</button>
          ))}
        </div>
        <div className="role-note">{ROLE_NOTES[role.actingAs]}</div>
      </div>

      <div className="account-section">
        <div className="kicker">Theme</div>
        <ThemeSwitcher />
      </div>

      <div className="account-actions">
        {canOversee && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { onDone(); navigate('/admin'); }}>
            Admin
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>Sign out</button>
      </div>
    </>
  );
}

function RecentList({ onPick }) {
  const navigate = useNavigate();
  const items = readRecents();
  if (!items.length) {
    return <p className="muted small" style={{ margin: 0 }}>Contracts you open appear here.</p>;
  }
  return (
    <div className="recent-list">
      {items.map((r) => (
        <button
          key={r.id}
          type="button"
          className="refbtn recent-item"
          onClick={() => { onPick(); navigate(`/contracts/${r.id}`); }}
        >
          <span className="recent-ref">{r.reference}</span>
          {r.subtitle && <span className="recent-sub">{r.subtitle}</span>}
        </button>
      ))}
    </div>
  );
}

const RECENTS_KEY = 'biq_recent_placements';

export function readRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? JSON.parse(raw).slice(0, 6) : [];
  } catch {
    return [];
  }
}

/** Record a contract worked on so it shows in the top bar's recents. */
export function rememberContract(entry) {
  if (!entry?.id) return;
  try {
    const next = [entry, ...readRecents().filter((r) => r.id !== entry.id)].slice(0, 6);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); recents are
    // a convenience, so failing to persist them must not break navigation.
  }
}
