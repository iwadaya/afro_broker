import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Blueprint, ErrorBanner } from '../components.jsx';
import BrandLockup from '../BrandLockup.jsx';

const ROLE_LABEL = { broker: 'Broker', senior_broker: 'Senior Broker', underwriter: 'Underwriter', admin: 'Admin' };

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('broker@broking.local');
  const [password, setPassword] = useState('');
  const [demo, setDemo] = useState(null); // { enabled, password, users }
  const [error, setError] = useState(null);

  // Demo sign-in: a dropdown of users with the one demo password filled in,
  // when the server offers it.
  useEffect(() => {
    api('GET', '/auth/demo-users')
      .then((d) => {
        setDemo(d);
        if (d.enabled) {
          setPassword(d.password);
          if (d.users.length && !d.users.some((u) => u.email === email)) setEmail(d.users[0].email);
        }
      })
      .catch(() => setDemo({ enabled: false, users: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    }
  }

  const pick = (value) => {
    setEmail(value);
    if (demo?.enabled) setPassword(demo.password);
  };

  return (
    <div className="login-wrap">
      <Blueprint className="login">
        <div>
          <BrandLockup size="login" className="brand-name" />
          <div className="brand-sub">Reinsurance placement</div>
        </div>
        <form onSubmit={submit}>
          {demo?.enabled && demo.users.length > 0 && (
            <label className="field">
              <span>Sign in as</span>
              <select className="input" value={demo.users.some((u) => u.email === email) ? email : ''}
                onChange={(e) => pick(e.target.value)} data-testid="demo-user">
                {demo.users.map((u) => (
                  <option key={u.email} value={u.email}>{u.name} · {ROLE_LABEL[u.role] || u.role} · {u.email}</option>
                ))}
                {!demo.users.some((u) => u.email === email) && <option value="">— other —</option>}
              </select>
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" autoComplete="username" />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input" value={password} type="password" onChange={(e) => setPassword(e.target.value)} placeholder="password" autoComplete="current-password" />
          </label>
          <button type="submit" className="btn btn-primary btn-block">Sign in</button>
        </form>
        <ErrorBanner error={error} />
        {demo?.enabled
          ? <p className="muted small">Demo: pick a user above — every account signs in with <code>{demo.password}</code>.</p>
          : <p className="muted small">Sign in with the account you were given.</p>}
      </Blueprint>
    </div>
  );
}
