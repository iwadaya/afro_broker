// useBrokingContract — load / save a contract bundle with row_version locking.
//   • save(kind, payload, { force }) PUTs header | prop-detail | np-structure with the
//     current rowVersion; the fresh bundle replaces local state.
//   • a 409 STALE_WRITE sets `conflict` for the Reload / Overwrite dialog.
//   • `dirtyRef` + `saveRef` feed useAutosaveOnLeave: leaving a step saves a draft.
//   • `savedAt` drives the "Draft saved HH:MM" indicator.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorBody } from '../../api';

export function useBrokingContract(contractId) {
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(!!contractId);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const bundleRef = useRef(null);
  useEffect(() => { bundleRef.current = bundle; }, [bundle]);

  const reload = useCallback(async () => {
    if (!contractId) return null;
    setLoading(true); setError(null);
    try { const b = await api.broking.getContract(contractId); setBundle(b); bundleRef.current = b; return b; }
    catch (e) { setError(e); return null; }
    finally { setLoading(false); }
  }, [contractId]);

  useEffect(() => { reload(); }, [reload]);

  /**
   * @returns {{ ok: boolean, bundle?: object, conflict?: boolean, fields?: Array, message?: string }}
   */
  const save = useCallback(async (kind, payload, { force = false, draft = false } = {}) => {
    const cur = bundleRef.current;
    if (!contractId || !cur) return { ok: false, message: 'Contract not loaded' };
    setSaving(true); setSaveError(null);
    const body = { rowVersion: cur.rowVersion, ...(force ? { force: true } : {}), ...payload };
    const call = kind === 'header' ? api.broking.putHeader : kind === 'prop-detail' ? api.broking.putPropDetail : api.broking.putNpStructure;
    try {
      const next = await call(contractId, body);
      setBundle(next); bundleRef.current = next;
      setSavedAt(new Date()); setConflict(null);
      return { ok: true, bundle: next, draft };
    } catch (e) {
      const b = errorBody(e) || {};
      if (e.status === 409 && b.code === 'STALE_WRITE') {
        setConflict({ current: b.current, expected: b.expected, retry: () => save(kind, payload, { force: true, draft }) });
        return { ok: false, conflict: true, message: b.error };
      }
      const message = b.error || e.message || 'Save failed';
      setSaveError({ message, fields: b.fields || [], missing: b.missing || [] });
      return { ok: false, message, fields: b.fields || [], missing: b.missing || [] };
    } finally { setSaving(false); }
  }, [contractId]);

  const resolveConflict = useCallback(async (action) => {
    const c = conflict;
    setConflict(null);
    if (!c) return null;
    if (action === 'reload') return reload();
    return c.retry();
  }, [conflict, reload]);

  const applyBundle = useCallback((b) => { setBundle(b); bundleRef.current = b; }, []);

  return { bundle, loading, error, reload, save, saving, savedAt, saveError, conflict, resolveConflict, applyBundle, bundleRef };
}

/**
 * Leaving a step autosaves a draft (Universe useTreatyHeaderUnmountAutosave): on
 * unmount, when the screen is dirty, call the screen's latest save in draft mode.
 * Also asks the browser for the native leave warning while edits are unsaved.
 */
export function useAutosaveOnLeave({ dirtyRef, saveRef }) {
  useEffect(() => {
    const onBeforeUnload = (e) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- reading the LIVE ref values on unmount is this hook's whole point
      const save = dirtyRef.current ? saveRef.current : null;
      if (save) Promise.resolve(save({ draft: true })).catch(() => {});
    };
  }, [dirtyRef, saveRef]);
}
