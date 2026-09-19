// The stored session is a cached copy of the cookie session: a 401 outside sign-in
// signs the user out with a notice (also when it happened during the boot check,
// before the provider mounted), and a wrong password never touches it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AppProvider, useAppState, SESSION_EXPIRED_NOTICE } from './AppContext';
import { api, clearSessionExpiry } from '../api';
import { getSession, setSession } from '../utils/auth';

const STORED = { userId: 'u-1', username: 'aabi.broker', displayName: 'Dar Chville', roleCode: 'BROKER', brokingEnabled: true };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function Probe() {
  const { session, authNotice } = useAppState();
  return <div><span data-testid="who">{session ? session.displayName : 'signed-out'}</span><span data-testid="notice">{authNotice}</span></div>;
}
const mount = () => render(<AppProvider initialConfig={{ brokingEnabled: true }}><Probe /></AppProvider>);

let fetchMock;
beforeEach(() => { localStorage.clear(); clearSessionExpiry(); fetchMock = vi.fn(); globalThis.fetch = fetchMock; });
afterEach(() => { vi.restoreAllMocks(); });

describe('AppContext session handling', () => {
  it('renders the stored session without a notice on a normal boot', () => {
    setSession(STORED);
    fetchMock.mockImplementation(async () => json(200, { brokingEnabled: true }));
    mount();
    expect(screen.getByTestId('who')).toHaveTextContent('Dar Chville');
    expect(screen.getByTestId('notice')).toHaveTextContent('');
  });

  it('shows the expiry notice when the boot check (before mount) got a 401', async () => {
    setSession(STORED);
    fetchMock.mockImplementation(async () => json(401, { error: 'Not authenticated.', code: 'UNAUTHORIZED' }));
    await expect(api.getMe()).rejects.toMatchObject({ status: 401 });   // what AuthBootstrap does first
    expect(getSession()).toBeNull();
    mount();
    expect(screen.getByTestId('who')).toHaveTextContent('signed-out');
    expect(screen.getByTestId('notice')).toHaveTextContent(SESSION_EXPIRED_NOTICE);
  });

  it('a 401 on any later API call signs out with the notice', async () => {
    setSession(STORED);
    fetchMock.mockImplementation(async () => json(401, { code: 'UNAUTHORIZED' }));
    mount();
    expect(screen.getByTestId('who')).toHaveTextContent('Dar Chville');
    await act(async () => { await api.broking.listContracts().catch(() => {}); });
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('signed-out'));
    expect(screen.getByTestId('notice')).toHaveTextContent(SESSION_EXPIRED_NOTICE);
    expect(getSession()).toBeNull();
  });

  it('a wrong password (401 on /api/auth/login) leaves the app alone', async () => {
    fetchMock.mockImplementation(async () => json(401, { error: 'Invalid username or password.' }));
    mount();
    await act(async () => { await expect(api.login('aabi.broker', 'nope')).rejects.toMatchObject({ status: 401 }); });
    expect(screen.getByTestId('who')).toHaveTextContent('signed-out');
    expect(screen.getByTestId('notice')).toHaveTextContent('');
  });
});
