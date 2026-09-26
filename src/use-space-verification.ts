import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiskHarborAPI, SpaceCheck, Summary } from './types';
import { rawError } from './errors';

interface CheckState {
  scanId: string;
  rootPath: string;
  check: SpaceCheck | null;
  busy: boolean;
  error: string;
}

function allowed(api: DiskHarborAPI | null, summary: Summary | null, locked: boolean) {
  return !!api && !!summary && !locked && (summary.state === 'completed' || summary.state === 'cancelled');
}

export function useSpaceVerification(api: DiskHarborAPI | null, summary: Summary | null, locked: boolean) {
  const [state, setState] = useState<CheckState | null>(null);
  const generation = useRef(0);
  const active = useRef<{ scanId: string; request: number } | null>(null);
  const latest = useRef({ api, summary, locked });
  latest.current = { api, summary, locked };
  const scanId = summary?.scanId;
  const rootPath = summary?.rootPath;

  useEffect(() => {
    generation.current++;
    active.current = null;
    setState(null);
    return () => {
      generation.current++;
      active.current = null;
    };
  }, [api, scanId, rootPath]);

  const measure = useCallback(async () => {
    const origin = latest.current;
    if (!origin.api || !origin.summary || !allowed(origin.api, origin.summary, origin.locked)) return;
    if (active.current?.scanId === origin.summary.scanId) return;
    const { scanId: requestScanId, rootPath: requestRoot } = origin.summary;
    const request = ++generation.current;
    active.current = { scanId: requestScanId, request };
    const empty: CheckState = { scanId: requestScanId, rootPath: requestRoot, check: null, busy: false, error: '' };
    setState({ ...empty, busy: true });
    const isCurrent = () => generation.current === request && latest.current.api === origin.api
      && latest.current.summary?.scanId === requestScanId && latest.current.summary.rootPath === requestRoot;

    try {
      const check = await origin.api.measureSpace(requestScanId);
      if (!isCurrent()) return;
      if (!allowed(latest.current.api, latest.current.summary, latest.current.locked)) { setState(null); return; }
      if (check.scanId !== requestScanId || check.rootPath !== requestRoot) throw new Error('SCAN_CHANGED');
      setState({ ...empty, check });
    } catch (error) {
      if (!isCurrent()) return;
      if (!allowed(latest.current.api, latest.current.summary, latest.current.locked)) { setState(null); return; }
      setState({ ...empty, error: rawError(error) || 'SPACE_CHECK_FAILED' });
    } finally {
      if (active.current?.request === request) active.current = null;
    }
  }, []);

  // Gate during render so a replacement scan never briefly displays the old result.
  const current = state?.scanId === scanId && state?.rootPath === rootPath ? state : null;
  const busy = current?.busy || false;
  return {
    check: current?.check || null,
    busy,
    error: current?.error || '',
    canMeasure: allowed(api, summary, locked) && !busy,
    measure,
  };
}
