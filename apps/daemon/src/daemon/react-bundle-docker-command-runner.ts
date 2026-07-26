import type { HostCommandRuntime } from '../command-host/contract.js';
import type { DockerClientCommandRunner } from './docker-client-command.js';
import { createHostRoutedDockerCommandRunner } from './docker-host-command.js';
import { resolveToolOutputProjectionPolicyFromEnv } from './agent/tool-output-offload.js';

// P7.6 item 4 — 조립이 내부 명령의 실행 위치를 정한다(boundaries: daemon-composition).
// react-bundle 의존성 admission의 docker는 데몬의 자식이 아니라 command-host 워커의
// system 세션에서 돈다. agent 층은 process-execution을 직접 만질 수 없으므로(경계
// 규칙), 이 결정을 여기서 소유하고 agent는 이 팩토리만 import한다.
//
// 진단 출력 상한은 데몬 tool 출력 정책의 inline 예산을 따른다 — context.ts가
// command-host 세션을 구성할 때 쓰는 값과 같은 출처다.
export function createReactBundleDockerCommandRunner(deps: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
}): DockerClientCommandRunner {
  const inlineMaxBytes =
    resolveToolOutputProjectionPolicyFromEnv().inlineMaxBytes;
  return createHostRoutedDockerCommandRunner({
    hostCommands: deps.hostCommands,
    stateRoot: deps.stateRoot,
    pageLimitBytes: inlineMaxBytes,
    // react-bundle은 docker 출력을 가용성 판정에만 쓰고 실제 산출물은 mount 파일에서
    // 읽는다 — 진단은 inline 예산만큼만 회수한다.
    maxOutputBytes: inlineMaxBytes,
  });
}
