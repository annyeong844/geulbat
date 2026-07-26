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
export function useDaemonConnection(options?: { onRecovered?: () => void }): {
  state: DaemonConnectionState;
  reconnect: () => void;
} {
  const [state, setState] = useState<DaemonConnectionState>('connected');
  const failureCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef({
    active: true,
    onRecovered: options?.onRecovered,
  });
  mountedRef.current.onRecovered = options?.onRecovered;

  const runProbe = useCallback(async () => {
    const healthy = await probeHealth();
    if (!mountedRef.current.active) {
      return;
    }
    if (healthy) {
      const recovered = failureCountRef.current > 0;
      failureCountRef.current = 0;
      setState('connected');
      if (recovered) {
        mountedRef.current.onRecovered?.();
      }
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
    const mounted = mountedRef.current;
    mounted.active = true;
    void runProbe();
    return () => {
      mounted.active = false;
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
