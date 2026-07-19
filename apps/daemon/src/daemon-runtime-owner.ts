import type { RunChannelRuntimeContext } from './adapter/web/ws/run-channel-runtime-context.js';
import type { DaemonRuntimeSessionClosers } from './daemon-server-lifecycle.js';
import type { DaemonContext } from './daemon/context.js';

// Daemon lifecycle state owner — state-owner 트랙의 마지막 슬라이스.
// DaemonContext는 composition container로 유지하고(무변경), 이 owner는
// 프로세스 생명주기 상태(phase, admission lock 핸들, server·WS 핸들,
// shutdown 단일 비행 promise)만 단독 소유한다. 소유하는 invariant:
//
// - 시작 순서 단일 소유: admission lock → provider auth → app 구성 →
//   server 생성 → WS 부착(capability projection) → callback 바인딩 →
//   listen. lock 획득 이후 실패하면 lock을 해제한 뒤 rethrow한다.
// - shutdown 단일 비행: 동시 shutdown 호출은 같은 promise에 합류하고,
//   closed 확정은 finally에서 보장된다.
// - 종료 대상 열거 단일화: DaemonContext에서 runtime session closer들을
//   도출하는 곳은 여기 한 곳뿐이다(엔트리의 수동 열거 제거).
// - run-channel에는 DaemonContext 전체가 아니라 좁은
//   RunChannelRuntimeContext projection만 전달한다.
//
// 효과(lock 획득, provider auth init, app·server 구성, WS 부착, listen,
// 종료 절차)는 전부 정책으로 주입받는다. 전이 순서는 owner가, 효과는
// 정책이 갖는다.
type DaemonRuntimePhase =
  | 'created'
  | 'starting'
  | 'running'
  | 'closing'
  | 'closed';

type DaemonRuntimeBootPhase =
  | 'admission-lock'
  | 'provider-auth'
  | 'create-daemon'
  | 'listen';

interface DaemonRuntimeAdmissionLock {
  release(): Promise<void>;
}

interface DaemonRuntimeOwnerPolicies<App, Server, SocketServer> {
  acquireAdmissionLock(args: {
    stateRoot: string;
  }): Promise<DaemonRuntimeAdmissionLock>;
  initProviderAuth(): Promise<void>;
  createApp(): Promise<App>;
  createHttpServer(app: App): Server;
  attachWebSockets(args: {
    server: Server;
    runtimeContext: RunChannelRuntimeContext;
  }): readonly SocketServer[];
  bindProviderAuthCallback(server: Server): void;
  listen(args: { server: Server; port: number; host: string }): Promise<void>;
  closeForShutdown(args: {
    admissionLock: DaemonRuntimeAdmissionLock;
    runtimeSessions: DaemonRuntimeSessionClosers;
    server: Server;
    webSocketServers: readonly SocketServer[];
    signal?: AbortSignal;
  }): Promise<void>;
  onBootPhase?(phase: DaemonRuntimeBootPhase): void;
}

interface DaemonRuntimeOwner {
  start(args: {
    port: number;
    host: string;
    /** listen 직전 훅 — 엔트리가 signal 핸들러 등록 지점을 보존한다. */
    beforeListen?: () => void;
  }): Promise<void>;
  shutdown(args?: { signal?: AbortSignal }): Promise<void>;
}

export function createDaemonRuntimeOwner<App, Server, SocketServer>(args: {
  daemonContext: DaemonContext;
  policies: DaemonRuntimeOwnerPolicies<App, Server, SocketServer>;
}): DaemonRuntimeOwner {
  const { daemonContext, policies } = args;
  let phase: DaemonRuntimePhase = 'created';
  let admissionLock: DaemonRuntimeAdmissionLock | undefined;
  let server: Server | undefined;
  let webSocketServers: readonly SocketServer[] = [];
  let shutdownPromise: Promise<void> | undefined;

  return {
    async start(startArgs) {
      if (phase !== 'created') {
        throw new Error('daemon runtime owner has already started');
      }
      phase = 'starting';
      let lock: DaemonRuntimeAdmissionLock;
      try {
        lock = await policies.acquireAdmissionLock({
          stateRoot: daemonContext.homeStateRoot,
        });
      } catch (error: unknown) {
        phase = 'closed';
        throw error;
      }
      admissionLock = lock;
      policies.onBootPhase?.('admission-lock');
      try {
        await policies.initProviderAuth();
        policies.onBootPhase?.('provider-auth');
        const app = await policies.createApp();
        policies.onBootPhase?.('create-daemon');
        const startedServer = policies.createHttpServer(app);
        server = startedServer;
        webSocketServers = policies.attachWebSockets({
          server: startedServer,
          runtimeContext: projectRunChannelRuntimeContext(daemonContext),
        });
        policies.bindProviderAuthCallback(startedServer);
        startArgs.beforeListen?.();
        await policies.listen({
          server: startedServer,
          port: startArgs.port,
          host: startArgs.host,
        });
        policies.onBootPhase?.('listen');
        phase = 'running';
      } catch (error: unknown) {
        phase = 'closed';
        await lock.release();
        throw error;
      }
    },

    async shutdown(shutdownArgs) {
      if (shutdownPromise !== undefined) {
        return await shutdownPromise;
      }
      if (phase === 'closed') {
        return;
      }
      const lock = admissionLock;
      const startedServer = server;
      if (
        phase !== 'running' ||
        lock === undefined ||
        startedServer === undefined
      ) {
        throw new Error('daemon runtime owner is not running');
      }
      phase = 'closing';
      shutdownPromise = (async () => {
        try {
          await policies.closeForShutdown({
            admissionLock: lock,
            runtimeSessions: daemonRuntimeSessionClosers(daemonContext),
            server: startedServer,
            webSocketServers,
            ...(shutdownArgs?.signal === undefined
              ? {}
              : { signal: shutdownArgs.signal }),
          });
        } finally {
          phase = 'closed';
        }
      })();
      return await shutdownPromise;
    },
  };
}

// 종료 대상 runtime session은 여기 한 곳에서만 열거한다. 새 closable
// 도메인 runtime이 DaemonContext에 생기면 이 도출과
// daemon-server-lifecycle의 closer 계약에 함께 추가한다.
function daemonRuntimeSessionClosers(
  daemonContext: DaemonContext,
): DaemonRuntimeSessionClosers {
  return {
    computerDirectoryPicker: daemonContext.computerDirectoryPicker,
    globalMcp: daemonContext.globalMcp,
    ptcBrowserPageLoadEvidence: daemonContext.ptcBrowserPageLoadEvidence,
    ptcBrowserTextEvidence: daemonContext.ptcBrowserTextEvidence,
    ptcBrowserNavigate: daemonContext.ptcBrowserNavigate,
    ptcExecuteCode: daemonContext.ptcExecuteCode,
  };
}

function projectRunChannelRuntimeContext(
  daemonContext: DaemonContext,
): RunChannelRuntimeContext {
  return {
    activeRuns: daemonContext.activeRuns,
    approvalGrants: daemonContext.approvalGrants,
    approvalGate: daemonContext.approvalGate,
    artifactFrameToolDispatch: daemonContext.artifactFrameToolDispatch,
    backgroundNotifications: daemonContext.backgroundNotifications,
    liveRunEvents: daemonContext.liveRunEvents,
    runCheckpoints: daemonContext.runCheckpoints,
    ...(daemonContext.computerFileScope !== undefined
      ? { computerFileScope: daemonContext.computerFileScope }
      : {}),
    ...(daemonContext.computerFileRoot !== undefined
      ? { computerFileRoot: daemonContext.computerFileRoot }
      : {}),
    homeStateRoot: daemonContext.homeStateRoot,
    childRuns: daemonContext.childRuns,
    fileStateCache: daemonContext.fileStateCache,
    imageGeneration: daemonContext.imageGeneration,
    videoGeneration: daemonContext.videoGeneration,
    memoryIndex: daemonContext.memoryIndex,
    providerAuthRuntime: daemonContext.providerAuthRuntime,
    providerRequestOptions: daemonContext.providerRequestOptions,
    providerWebSocketSessions: daemonContext.providerWebSocketSessions,
    reactBundleStructuredOutputIngressPolicy:
      daemonContext.reactBundleStructuredOutputIngressPolicy,
    resourceBudgetProvider: daemonContext.resourceBudgetProvider,
    ptcBrowserPageLoadEvidence: daemonContext.ptcBrowserPageLoadEvidence,
    ptcBrowserTextEvidence: daemonContext.ptcBrowserTextEvidence,
    ptcBrowserNavigate: daemonContext.ptcBrowserNavigate,
    ptcExecuteCode: daemonContext.ptcExecuteCode,
    ptcPackageInstall: daemonContext.ptcPackageInstall,
    ptcFixedProbe: daemonContext.ptcFixedProbe,
    pluginSkills: daemonContext.pluginSkills,
    sandboxAttempts: daemonContext.sandboxAttempts,
    subagentAdmission: daemonContext.subagentAdmission,
    subagentRuns: daemonContext.subagentRuns,
    toolLibraryProjection: daemonContext.toolLibraryProjection,
    toolRegistry: daemonContext.toolRegistry,
  };
}
