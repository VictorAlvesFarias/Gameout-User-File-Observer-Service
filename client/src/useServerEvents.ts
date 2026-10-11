import { useEffect, useRef, useState } from 'react';
import type { DriverState, LogEntry, Notice } from './types';

const maxEntries = 500;

/**
 * Live state and log pushed by the server (Server-Sent Events, auto-reconnecting); onNotice
 * fires when a backup fails in the background.
 */
export function useServerEvents(onNotice: (notice: Notice) => void) {
  const [state, setState] = useState<DriverState | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const notice = useRef(onNotice);
  notice.current = onNotice;

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('state', (event) => setState(JSON.parse((event as MessageEvent).data)));
    // Sent on every (re)connection, so it replaces whatever was there.
    source.addEventListener('history', (event) => setLog(JSON.parse((event as MessageEvent).data)));
    source.addEventListener('log', (event) => {
      const entry = JSON.parse((event as MessageEvent).data) as LogEntry;
      setLog((current) => [...current.slice(-(maxEntries - 1)), entry]);
    });
    source.addEventListener('notice', (event) => notice.current(JSON.parse((event as MessageEvent).data)));
    return () => source.close();
  }, []);

  return { state, log, connected };
}
