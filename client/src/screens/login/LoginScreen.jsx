import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, errorBody } from '../../api';
import { useAppState } from '../../context/AppContext';
import ThemeSwitcher from '../../components/ThemeSwitcher';

export default function LoginScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn, authNotice } = useAppState();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await api.login(username.trim(), password);
      signIn(res.session);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(errorBody(err)?.error || 'Sign-in failed. Check your username and password.');
    } finally { setBusy(false); }
  }

  return (
    <div className="ab ab-login">
      <form className="ab-pane ab-login-pane" onSubmit={submit}>
        <div className="ab-pane-head"><span className="ab-pane-title">Sign in</span><span className="ab-tag">AABI</span></div>
        <div className="ab-pane-body">
          <p className="ab-help">Afro_Asian_Business_Intelligence — treaty capture for reinsurance broking.</p>
          {authNotice && <div className="ab-notice warn" role="status" data-testid="auth-notice">{authNotice}</div>}
          <div className="ab-fr"><label htmlFor="login-user">Username</label><input id="login-user" className="ab-in" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
          <div className="ab-fr"><label htmlFor="login-pass">Password</label><input id="login-pass" className="ab-in" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          {error && <div className="ab-umr-status is-bad" role="alert">{error}</div>}
          <div className="ab-actions">
            <ThemeSwitcher compact />
            <button type="submit" className="ab-btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
