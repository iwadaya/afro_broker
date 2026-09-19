// AuthBootstrap verifies a stored session before anything protected renders.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AuthBootstrap from './AuthBootstrap';
import { AppProvider, useAppState, SESSION_EXPIRED_NOTICE } from '../../context/AppContext';
import { clearSessionExpiry } from '../../api';
import { getSession, setSession } from '../../utils/auth';

const STORED = { userId: 'u-1', username: 'aabi.broker', displayName: 'Old Name', roleCode: 'BROKER' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function Probe() { const { session, authNotice } = useAppState(); return <div><span data-testid="who">{session ? session.displayName : 'signed-out'}</span><span data-testid="notice">{authNotice}</span></div>; }
const mount = () => render(<AuthBootstrap><AppProvider initialConfig={{}}><Probe /></AppProvider></AuthBootstrap>);

let fetchMock;
beforeEach(() => { localStorage.clear(); clearSessionExpiry(); fetchMock = vi.fn(); globalThis.fetch = fetchMock; });
afterEach(() => vi.restoreAllMocks());

describe('AuthBootstrap', () => {
  it('refreshes a stored session from /api/auth/me before rendering the app', async () => {
    setSession(STORED);
    fetchMock.mockImplementation(async () => json(200, { session: { ...STORED, displayName: 'Dar Chville' } }));
    mount();
    expect(screen.getByText('Checking your session…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('Dar Chville'));
    expect(getSession().displayName).toBe('Dar Chville');
    expect(screen.getByTestId('notice')).toHaveTextContent('');
  });
  it('a 401 drops the stored session and the app opens signed out with the expiry notice', async () => {
    setSession(STORED);
    fetchMock.mockImplementation(async () => json(401, { code: 'UNAUTHORIZED' }));
    mount();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('signed-out'));
    expect(screen.getByTestId('notice')).toHaveTextContent(SESSION_EXPIRED_NOTICE);
    expect(getSession()).toBeNull();
  });
  it('a network failure keeps the stored session and offers a retry', async () => {
    setSession(STORED);
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument());
    expect(getSession().displayName).toBe('Old Name');
  });
  it('no stored session renders the app straight away', () => {
    mount();
    expect(screen.getByTestId('who')).toHaveTextContent('signed-out');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
