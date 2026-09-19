import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, StatusPill, ErrorBanner, Tabs } from '../components.jsx';
import { useScreenHead, useRole } from '../shell.jsx';
import { useToast } from '../toast.jsx';
import { STAGES, stageOf, stageHints, furthestStage } from './renewal/stages.js';
import PackTab from './renewal/PackTab.jsx';
import SummaryTab from './renewal/SummaryTab.jsx';
import MarketEmailTab from './renewal/MarketEmailTab.jsx';
import ResponsesTab from './renewal/ResponsesTab.jsx';
import SignedLinesTab from './renewal/SignedLinesTab.jsx';
import ClaimsTab from './renewal/ClaimsTab.jsx';

const TAB_VIEWS = {
  pack: PackTab,
  summary: SummaryTab,
  email: MarketEmailTab,
  responses: ResponsesTab,
  signed: SignedLinesTab,
  claims: ClaimsTab,
};

/**
 * One uploaded pack's workspace — the renewal desk, in six stages.
 *
 * The same shape as the contract year's YearWorkspace: one tab strip, one
 * `shared` memo handed to every tab, one file per tab under views/renewal.
 * The stage is in the URL (?tab=summary) so it can be linked and survives a
 * reload; with no ?tab= the record opens on the furthest stage its data
 * supports. The run is orchestrated here rather than in a tab, because it
 * drives the tab strip, shows its progress on two tabs, and moves the desk
 * on to the summary when it lands.
 */
export default function RenewalAnalysisDetail() {
  const { id } = useParams();
  const { data: a, error, reload } = useFetch('GET', `/renewal-analyses/${id}`, [id]);
  useScreenHead('RENEWAL PACK', a ? `Uploaded pack — ${a.cedant_name}` : 'Uploaded pack', 'AI review');
  const role = useRole();
  const toast = useToast();
  // For the placement picker; the register carries the cedant names the
  // placement rows only hold by id.
  const placements = useFetch('GET', '/placements?limit=200');
  const cedants = useFetch('GET', '/cedants?limit=200');
  const [params, setParams] = useSearchParams();

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const analysing = running || a?.status === 'analysing';

  // A one-second tick, only while a run is in flight, so the wait shows its
  // own elapsed time rather than an unmoving spinner.
  useEffect(() => {
    if (!analysing) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [analysing]);

  // The stage, from the URL. An unknown or missing ?tab= is the furthest
  // stage the record supports, and is not written back — the URL only
  // carries a stage once someone has chosen one.
  const requested = stageOf(params.get('tab'))?.value;
  const tab = requested || (a ? furthestStage(a) : 'pack');
  const setTab = useCallback((value) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', value);
      return next;
    }, { replace: true });
  }, [setParams]);

  // The broker's sign-off is on the record (verified_at / verified_by); the
  // API clears it whenever the draft or the packs change under it.
  const verified = Boolean(a?.result && a?.verified_at);

  // Run (or re-run) the analysis over the uploaded packs. A run that lands
  // opens the summary — the design's move from intake to the draft.
  const run = useCallback(async () => {
    setRunning(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    setRunError(null);
    let ok = false;
    try {
      await api('POST', `/renewal-analyses/${id}/run`);
      ok = true;
    } catch (err) {
      setRunError(err);
    } finally {
      setRunning(false);
      setStartedAt(null);
      reload();
    }
    if (ok) {
      setTab('summary');
      toast('The model has read the pack — the summary is drafted for review.');
    }
  }, [id, reload, setTab, toast]);

  const shared = useMemo(() => ({
    id,
    analysis: a,
    result: a?.result || null,
    role,
    canRun: role.canBroke || role.canAuthorise,
    aiConfigured: (a?.providers || []).some((p) => p.configured),
    analysing,
    startedAt,
    now,
    run,
    runError,
    reload,
    verified,
    placements: placements.data || [],
    cedants: cedants.data || [],
    setTab,
  }), [id, a, role, analysing, startedAt, now, run, runError, reload, verified,
    placements.data, cedants.data, setTab]);

  if (error) return <div className="screen"><ErrorBanner error={error} /></div>;
  if (!a) return null;

  const hints = stageHints({ analysis: a, analysing });
  const View = TAB_VIEWS[tab];

  return (
    <div className="screen rpa-screen">
      <div className="muted small rpa-crumb">
        <Link to="/renewal-packs?book=1">Renewal packs</Link> / {a.cedant_name} <StatusPill value={a.status} />
      </div>

      <Tabs
        className="rpa-tabs"
        label="Renewal desk stages"
        value={tab}
        onChange={setTab}
        tabs={STAGES.map((s) => ({ ...s, sub: hints[s.value] }))}
      />

      <View shared={shared} />
    </div>
  );
}
