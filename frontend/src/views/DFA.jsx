import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, ErrorBanner, Tabs } from '../components.jsx';
import { useScreenHead, useWorkspace } from '../shell.jsx';
import { useToast } from '../toast.jsx';
import { STAGES, stageOf, stageHints } from './dfa/stages.js';
import {
  editableStructure, structuresEqual, runBody, resolveMode, blankCalibration, runnable, seedScenarios,
  seedAppetite, defaultGrid, gridProblem, structuringBody,
} from './dfa/model.js';
import Headline from './dfa/Headline.jsx';
import ScopeTab from './dfa/ScopeTab.jsx';
import ProgrammeTab from './dfa/ProgrammeTab.jsx';
import AssumptionsTab from './dfa/AssumptionsTab.jsx';
import ImpactTab from './dfa/ImpactTab.jsx';
import CapitalTab from './dfa/CapitalTab.jsx';
import CoversTab from './dfa/CoversTab.jsx';
import ScenariosTab from './dfa/ScenariosTab.jsx';
import StructuringTab from './dfa/StructuringTab.jsx';

const TAB_VIEWS = {
  scope: ScopeTab,
  programme: ProgrammeTab,
  assumptions: AssumptionsTab,
  impact: ImpactTab,
  capital: CapitalTab,
  covers: CoversTab,
  scenarios: ScenariosTab,
  structuring: StructuringTab,
};

/**
 * Dynamic financial analysis — the what-if desk, in eight stages under one
 * verdict, independent of any one placement.
 *
 * What it models is the first question: a **standalone** book typed from
 * scratch (nothing read from the register, the programme built by hand),
 * **one contract** read from a placement, or the **whole portfolio** (every
 * placement with a premium, narrowed to a selection if wanted). The verdict
 * strip never leaves the top of the screen: one sentence a buyer can take
 * into the room, the five figures under it, and the run button. Under that
 * the desk walks left to right — 01 the scope and its loss model, 02 the
 * current programme beside the proposed one, 03 the assumptions (the
 * insurer's domicile among them, whose capital regime the capital is read
 * against) — and then reads the run: 04 what the change does, 05 the
 * capital, 06 each cover and the panel, 07 the CAS Handbook's scenarios,
 * each re-run on the same seed with one thing moved — and 08 turns the run
 * into a structure decision: the four families across a range of
 * retentions tested on the same years (its own button, its own request),
 * read against the stated appetite, with the pick one click from becoming
 * the proposed programme. Every programme is applied to the same simulated
 * treaty years (backend domain/dfa.js), so a change in the numbers is the
 * change in the programme, never sampling noise.
 *
 * The scope, the stage and the selection live in the URL (?scope=, ?tab=,
 * ?placements=, and ?ccy= for a standalone book) so a reading can be linked
 * and survives a reload. Reads only: nothing here writes back to a placement.
 */
export default function DFA() {
  const [params, setParams] = useSearchParams();
  const ws = useWorkspace();
  const toast = useToast();

  // What is being modelled, from the URL. A contract or a narrowed portfolio
  // reads its combined view for the selection; a standalone book and the
  // whole portfolio read the book as it is (the register for the picker, the
  // defaults, the panel).
  const placementsParam = params.get('placements') || '';
  const selection = placementsParam ? placementsParam.split(',').filter(Boolean) : null;
  const mode = resolveMode(params.get('scope'), selection);
  const selectionKey = mode === 'contract' || mode === 'portfolio' ? placementsParam : '';
  const portfolio = useFetch(
    'GET',
    `/dfa/portfolio${selectionKey ? `?placements=${selectionKey}` : ''}`,
    [selectionKey],
  );

  // The capital regimes by country, for the domicile picker on 03.
  const regimes = useFetch('GET', '/dfa/regimes', []);

  const setScope = useCallback(({ mode: next, placements, ccy }) => {
    setParams((prev) => {
      const q = new URLSearchParams(prev);
      q.set('scope', next);
      if (placements?.length) q.set('placements', placements.join(','));
      else q.delete('placements');
      if (next === 'standalone' && ccy != null) q.set('ccy', ccy);
      if (next !== 'standalone') q.delete('ccy');
      return q;
    }, { replace: true });
  }, [setParams]);
  const setSelection = useCallback((ids) => setScope({ mode: 'portfolio', placements: ids }), [setScope]);
  const setStandaloneCcy = useCallback((ccy) => setScope({ mode: 'standalone', ccy }), [setScope]);

  const requested = stageOf(params.get('tab'))?.value;
  const tab = requested || 'scope';
  const setTab = useCallback((value) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', value);
      return next;
    }, { replace: true });
  }, [setParams]);

  const [cal, setCal] = useState(null);
  const [current, setCurrent] = useState(null);
  const [proposed, setProposed] = useState(null);
  const [assumptions, setAssumptions] = useState(null);
  const [scenarios, setScenariosState] = useState(null);
  const [scan, setScanState] = useState('none');
  const [results, setResults] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [runError, setRunError] = useState(null);
  const [stale, setStale] = useState(false);
  const autoRan = useRef(false);
  // 08 Structuring: the appetite, the grid, and the sweep — its own run.
  const [appetite, setAppetiteState] = useState(null);
  const [grid, setGridState] = useState(null);
  const gridTouched = useRef(false);
  const [sweep, setSweep] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepStale, setSweepStale] = useState(false);
  const [sweepError, setSweepError] = useState(null);
  const [sweepStartedAt, setSweepStartedAt] = useState(null);

  // (Re)seed the editors whenever the book lands or the scope changes: a
  // standalone book starts blank from the API's defaults, a contract or the
  // portfolio from its combined view. A different scope is a different
  // analysis, so the old run goes. The book read for one selection must not
  // seed another: while a new selection's read is in flight the old one's
  // data is still in hand, so the effect waits for the read that answers
  // the URL — else a contract picked from the whole book would run, for a
  // moment, as the whole book.
  const sameSelection = (data) => {
    const want = selectionKey.split(',').filter(Boolean).sort().join(',');
    const got = [...(data.requested || [])].sort().join(',');
    return want === got;
  };
  useEffect(() => {
    const data = portfolio.data;
    if (!data || !sameSelection(data)) return;
    if (mode === 'standalone') {
      setCal(blankCalibration(data.defaults));
      setCurrent(editableStructure(null));
      setProposed(editableStructure(null));
    } else if (mode !== 'unchosen' && data.combined) {
      setCal({ ...data.combined.calibration });
      setCurrent(editableStructure(data.combined.structure));
      setProposed(editableStructure(data.combined.structure));
    } else {
      setCal(null);
      setCurrent(null);
      setProposed(null);
    }
    setAssumptions((a) => {
      if (!a) return { ...data.defaults };
      // A new selection brings its cedants' domicile with it; a book with no
      // one domicile keeps whatever was chosen.
      return data.defaults.domicile && data.defaults.domicile !== a.domicile
        ? { ...a, domicile: data.defaults.domicile } : a;
    });
    setScenariosState((s) => s || seedScenarios(data.defaults));
    // The appetite is the insurer's statement and outlives the scope; the
    // grid follows the book until it is edited; a sweep belongs to its scope.
    setAppetiteState((a) => a || seedAppetite(data.defaults));
    gridTouched.current = false;
    setSweep(null);
    setSweepStale(false);
    setSweepError(null);
    setResults(null);
    setLastRun(null);
    setStale(false);
    setRunError(null);
    autoRan.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio.data, mode, selectionKey]);

  // The grid reads the book — the current tower's retention and top, the
  // premium — until the broker edits it.
  useEffect(() => {
    if (!cal || !current || gridTouched.current) return;
    setGridState(defaultGrid({ cal, current, defaults: portfolio.data?.defaults }));
  }, [cal, current, portfolio.data]);

  // A one-second tick while a run or a sweep is in flight, so the wait shows its own time.
  useEffect(() => {
    if (!running && !sweeping) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, sweeping]);

  const run = useCallback(async ({ auto = false, proposedOverride = null } = {}) => {
    const prop = proposedOverride || proposed;
    if (!cal || !runnable(cal) || !current || !prop || !assumptions || running) return;
    setRunning(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    setRunError(null);
    const sameAsCurrent = structuresEqual(current, prop);
    try {
      const res = await api('POST', '/dfa/run', runBody({ cal, current, proposed: prop, assumptions, scan, scenarios }));
      setResults(res);
      setLastRun({ at: new Date().toISOString(), sameAsCurrent, scan });
      setStale(false);
      if (!auto) toast('Analysis run — the verdict and every result stage are updated.');
    } catch (e) {
      setRunError(e);
    } finally {
      setRunning(false);
      setStartedAt(null);
    }
  }, [cal, current, proposed, assumptions, scan, scenarios, running, toast]);

  // A contract or the portfolio runs by itself once the book has seeded the
  // editors, so the desk opens on a verdict rather than a form. A standalone
  // book waits for its premium to be typed and the broker to press Run.
  useEffect(() => {
    if ((mode === 'contract' || mode === 'portfolio') && cal && runnable(cal)
      && current && proposed && assumptions && !autoRan.current) {
      autoRan.current = true;
      run({ auto: true });
    }
  }, [mode, cal, current, proposed, assumptions, run]);

  // The structuring sweep: every candidate the grid names, on the same
  // years as the current programme, read against the appetite.
  const runSweep = useCallback(async () => {
    if (!cal || !runnable(cal) || !current || !assumptions || !appetite || !grid || sweeping) return;
    const problem = gridProblem(grid);
    if (problem) { setSweepError(new Error(problem)); return; }
    setSweeping(true);
    setSweepStartedAt(Date.now());
    setNow(Date.now());
    setSweepError(null);
    try {
      const res = await api('POST', '/dfa/structuring', structuringBody({ cal, current, proposed, assumptions, appetite, grid, scenarios }));
      setSweep({ ...res, at: new Date().toISOString() });
      setSweepStale(false);
      toast(`${res.defensible.tested} programmes tested — ${res.defensible.fits} fit the appetite.`);
    } catch (e) {
      setSweepError(e);
    } finally {
      setSweeping(false);
      setSweepStartedAt(null);
    }
  }, [cal, current, proposed, assumptions, appetite, grid, scenarios, sweeping, toast]);

  // The pick becomes the proposed programme, and the desk runs on it.
  const adopt = useCallback((candidate) => {
    const next = editableStructure(candidate.structure);
    setProposed(next);
    setStale(true);
    toast(`${candidate.label} is now the proposed programme — running the desk on it.`);
    run({ auto: true, proposedOverride: next });
  }, [run, toast]);

  // Every edit marks the standing run — and the standing sweep — as older than the inputs.
  const touch = (setter) => (updater) => { setter(updater); setStale(true); setSweepStale(true); };
  const setScan = useCallback((v) => { setScanState(v); setStale(true); }, []);
  const setAppetite = useCallback((updater) => { setAppetiteState(updater); setSweepStale(true); }, []);
  const setGrid = useCallback((updater) => { gridTouched.current = true; setGridState(updater); setSweepStale(true); }, []);

  const p = portfolio.data;
  const ccy = mode === 'standalone'
    ? (params.get('ccy') || '')
    : (p?.currencies?.length === 1 ? p.currencies[0] : '');
  const selectedCount = p?.selected?.length || 0;
  const single = mode === 'contract' && selectedCount === 1
    ? p.placements.find((x) => x.id === p.selected[0]) : null;
  let tag = null;
  if (p && mode === 'standalone') tag = `Standalone model${ccy ? ` · ${ccy}` : ''}`;
  else if (p && mode === 'contract') tag = single ? `${single.reference} · ${single.cedant_name}${ccy ? ` · ${ccy}` : ''}` : 'One contract';
  else if (p && mode === 'portfolio') tag = `${selection ? `${selectedCount} contracts` : `Whole portfolio · ${selectedCount}`}${ccy ? ` · ${ccy}` : ''}`;
  useScreenHead('Portfolio analytics', 'Dynamic financial analysis', tag);

  const shared = useMemo(() => ({
    portfolio: p,
    mode,
    selection,
    setScope,
    setSelection,
    setStandaloneCcy,
    workingPlacementId: ws?.placement?.id || null,
    cal,
    setCal: touch(setCal),
    current,
    setCurrent: touch(setCurrent),
    proposed,
    setProposed: touch(setProposed),
    assumptions,
    setAssumptions: touch(setAssumptions),
    scenarios,
    setScenarios: touch(setScenariosState),
    regimes: regimes.data,
    scan,
    setScan,
    results,
    lastRun,
    stale,
    running,
    startedAt,
    now,
    run,
    runError,
    ccy,
    tab,
    setTab,
    appetite,
    setAppetite,
    grid,
    setGrid,
    sweep,
    sweeping,
    sweepStale,
    sweepError,
    sweepStartedAt,
    runSweep,
    adopt,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [p, mode, selectionKey, setScope, setSelection, setStandaloneCcy, ws?.placement?.id, cal, current,
    proposed, assumptions, scenarios, regimes.data, scan, setScan, results, lastRun, stale, running,
    startedAt, now, run, runError, ccy, tab, setTab, appetite, setAppetite, grid, setGrid, sweep, sweeping,
    sweepStale, sweepError, sweepStartedAt, runSweep, adopt]);

  const hints = stageHints({ mode, portfolio: p, selection, proposed, assumptions, results, stale, running, sweep, sweeping, sweepStale });
  const View = TAB_VIEWS[tab];

  return (
    <div className="screen dfa-screen" data-mode={mode}>
      <ErrorBanner error={portfolio.error} />

      <Headline shared={shared} />

      <Tabs
        className="rpa-tabs dfa-tabs"
        label="Analysis stages"
        value={tab}
        onChange={setTab}
        tabs={STAGES.map((s) => ({ ...s, sub: hints[s.value] }))}
      />

      <View shared={shared} />
    </div>
  );
}
