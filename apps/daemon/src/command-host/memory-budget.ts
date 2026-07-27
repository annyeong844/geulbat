import {
  COMMAND_HOST_SESSION_CAPACITY,
  DEFAULT_TAIL_RING_BYTES,
} from './session-core.js';
import { MAX_STDIN_BUFFERED_BYTES_PER_SESSION } from './session-interaction.js';
import { COMMAND_HOST_RPC_LIMITS } from './worker-server.js';

// P7.5 spec v4 §4.1 — 전체 메모리 예산 표현.
//
// 3차 정밀화가 남긴 문장("128MiB는 출력 링 예산의 하드 상한이고, 워커 전체
// 메모리에는 §7.5의 예산이 더해진다")을 값으로 확정한 것이 이 모듈이다.
// 여기서 숫자를 새로 정하지 않는다 — 각 상한은 그것을 강제하는 소유자
// 모듈이 갖고 있고, 이 모듈은 그 값들을 곱하고 더해 총합을 서술만 한다.
// 강제되지 않는 항은 예산에 넣지 않는다.

const STREAMS_PER_SESSION = 2; // stdout·stderr는 별도 링·별도 좌표계 (§4.1)

interface CommandHostMemoryBudgetTerm {
  label: string;
  perUnitBytes: number;
  units: number;
  totalBytes: number;
  /** 이 항을 강제하는 코드가 있는 곳. */
  enforcedBy: string;
}

interface CommandHostMemoryBudget {
  /** §4.1 출력 링 예산의 하드 상한. */
  outputRingBytes: number;
  /** §7.5가 더하는 전송 계층 예산. */
  transportBytes: number;
  /** 워커 1개가 최악의 경우 붙들 수 있는 총량. */
  totalBytes: number;
  terms: CommandHostMemoryBudgetTerm[];
}

export function describeCommandHostMemoryBudget(
  config: { tailRingBytes?: number } = {},
): CommandHostMemoryBudget {
  const tailRingBytes = config.tailRingBytes ?? DEFAULT_TAIL_RING_BYTES;
  const limits = COMMAND_HOST_RPC_LIMITS;

  const outputRings: CommandHostMemoryBudgetTerm = {
    label: 'output tail rings',
    perUnitBytes: tailRingBytes,
    units: COMMAND_HOST_SESSION_CAPACITY * STREAMS_PER_SESSION,
    totalBytes:
      tailRingBytes * COMMAND_HOST_SESSION_CAPACITY * STREAMS_PER_SESSION,
    enforcedBy: 'session-core.ts TailRing + §4.4 admission',
  };

  const transport: CommandHostMemoryBudgetTerm[] = [
    {
      // accept된 모든 연결이 프레임 하나를 조립하는 중일 수 있다.
      label: 'inbound frame assembly',
      perUnitBytes: limits.maxFrameBytes,
      units: limits.maxAcceptedConnections,
      totalBytes: limits.maxFrameBytes * limits.maxAcceptedConnections,
      enforcedBy: 'protocol.ts FrameDecoder',
    },
    {
      // 응답 큐는 initialize를 마친 연결만 가질 수 있다.
      label: 'queued responses',
      perUnitBytes: limits.responseQueueHardBytes,
      units: limits.maxInitializedConnections,
      totalBytes:
        limits.responseQueueHardBytes * limits.maxInitializedConnections,
      enforcedBy: 'worker-server.ts sendResponse',
    },
    {
      label: 'queued notifications',
      perUnitBytes: limits.notificationQueueBytes,
      units: limits.maxInitializedConnections,
      totalBytes:
        limits.notificationQueueBytes * limits.maxInitializedConnections,
      enforcedBy: 'worker-server.ts sendNotification',
    },
    {
      label: 'in-flight requests',
      perUnitBytes: limits.maxAggregateInflightRequestBytes,
      units: 1, // 워커 전역 항
      totalBytes: limits.maxAggregateInflightRequestBytes,
      enforcedBy: 'worker-server.ts handleRequest',
    },
    {
      label: 'session stdin buffers',
      perUnitBytes: MAX_STDIN_BUFFERED_BYTES_PER_SESSION,
      units: COMMAND_HOST_SESSION_CAPACITY,
      totalBytes:
        MAX_STDIN_BUFFERED_BYTES_PER_SESSION * COMMAND_HOST_SESSION_CAPACITY,
      enforcedBy: 'session-core.ts writeStdin',
    },
  ];

  const transportBytes = transport.reduce(
    (sum, term) => sum + term.totalBytes,
    0,
  );
  return {
    outputRingBytes: outputRings.totalBytes,
    transportBytes,
    totalBytes: outputRings.totalBytes + transportBytes,
    terms: [outputRings, ...transport],
  };
}
