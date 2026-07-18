import { useCallback, useEffect, useRef, useState } from 'react';

export type DaemonConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

const POLL_INTERVAL_MS = 15_000;
const RETRY_INTERVAL_MS = 4_000;
const DISCONNECTED_AFTER_FAILURES = 3;

async function probeHealth(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Shell-side daemon connection indicator state (§3.1.8 / §3.6.3).
 *
 * Health polling only — daemon-side connection semantics는 이 훅의 owner가
 * 아니다. 실패가 이어지면 reconnecting → disconnected로 강등되고, 성공
 * 즉시 connected로 복귀한다.
 */
export function useDaemonConnection(): {
  state: DaemonConnectionState;
  reconnect: () => void;
} {
  const [state, setState] = useState<DaemonConnectionState>('connected');
  const failureCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const runProbe = useCallback(async () => {
    const healthy = await probeHealth();
    if (!mountedRef.current) {
      return;
    }
    if (healthy) {
      failureCountRef.current = 0;
      setState('connected');
    } else {
      failureCountRef.current += 1;
      setState(
        failureCountRef.current >= DISCONNECTED_AFTER_FAILURES
          ? 'disconnected'
          : 'reconnecting',
      );
    }
    timerRef.current = setTimeout(
      () => void runProbe(),
      healthy ? POLL_INTERVAL_MS : RETRY_INTERVAL_MS,
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void runProbe();
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [runProbe]);

  const reconnect = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    setState('reconnecting');
    void runProbe();
  }, [runProbe]);

  return { state, reconnect };
}
