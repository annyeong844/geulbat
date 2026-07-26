# 컨텍스트 주입 효율 측정 (context-injection accounting)

데몬이 provider에 보내는 요청 한 건이 **어느 부분에서 몇 바이트를 쓰는지**, 그리고
도구 호출부·도구 result 주입부의 효율 기제가 실제로 얼마나 절감하는지를
**결정론적으로(오프라인·무작위성 없음)** 측정한다. provider·네트워크·시계·난수를
쓰지 않으며, 데몬의 **실제 요청 조립/오프로드 코드 경로**를 그대로 구동한다.

- 하니스: [`probe-context-injection-accounting.mjs`](./probe-context-injection-accounting.mjs)
- 단위 테스트: [`probe-context-injection-accounting.test.mjs`](./probe-context-injection-accounting.test.mjs)

```sh
# 사람이 읽는 리포트
node --import tsx apps/daemon/scripts/probe-context-injection-accounting.mjs
# 또는
npm run probe:context-injection-accounting -w apps/daemon

# 기계용 JSON + 파일 저장
node --import tsx apps/daemon/scripts/probe-context-injection-accounting.mjs --json --out result.json
```

## 방법론

### 단위: 바이트가 정본, 토큰은 추정치

데몬은 컨텍스트 예산을 **요청 바이트**로 판단한다. 토큰은
`memory/compaction-loop.ts`의 `estimateInputTokens`가
`requestBytes × (inputTokens / requestBytes)` 로 환산하는데, 이 보정비는
**모델별로 실제 provider usage에서 학습**되며 **하드코딩 기본값이 없다**(실측 전엔
토큰 추정이 `undefined`). 따라서 이 하니스는 **바이트를 1차 지표**로 보고하고,
토큰은 `--bytes-per-token`(기본 4)로 명시적으로 라벨링한 **추정치**로만 낸다.
실제 관측 보정쌍을 넣으면 그 모델에 한해 정확해진다.

### 정본 측정기 (실제 코드)

| 측정 대상                   | 사용 함수                                          | 위치                                                 |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| 요청 전체 4-way 분해        | `measureResponsesRequest` 로직 재현                | `llm/provider/transport/responses-websocket.ts:246`  |
| 요청 body 조립              | `buildResponsesRequestBody`                        | `llm/provider/codex-request.ts:36`                   |
| history(입력 배열) 바이트   | `measureResponseWireInputBytes`                    | `llm/provider/transport/responses-wire-input.ts:100` |
| 도구 result 1건 wire 바이트 | `measureResponseWireFunctionCallOutputAppendBytes` | `responses-wire-input.ts:110`                        |
| directHot 도구 선택         | `createAgentLoopToolDefinitionPort`                | `agent/loop-tool-definitions.ts:14`                  |
| 도구 result 오프로드        | `maybeOffloadToolResult`                           | `agent/tool-output-offload.ts:250`                   |

요청은 `{ type:'response.create', ...body, input }` 형태로 직렬화되며(provider =
`openai_codex_direct`, OpenAI Responses 계열), 총 바이트를
`history`(=`input`) / `instructions`(시스템 프롬프트) / `toolDefinitions`(=`tools`) /
`envelope`(모델·플래그·`prompt_cache_key`·reasoning 등 나머지)로 쪼갠다.

## 결과 스냅샷 (기본 실행: `profile=root`, `turns=6`)

> 숫자는 기본 파라미터 실행의 스냅샷이다. 하니스를 재실행하면 그대로 재생성된다.

### 1. 요청 전체 구성 — mid-conversation 요청 1건

| 구성 요소                      |     바이트 |  비중 | 추정 토큰(4 B/tok) |
| ------------------------------ | ---------: | ----: | -----------------: |
| tool definitions (주입됨)      |     25,591 | 47.0% |             ~6,398 |
| history (턴 + 도구 result)     |     15,472 | 28.4% |             ~3,868 |
| instructions (시스템 프롬프트) |     13,108 | 24.1% |             ~3,277 |
| envelope                       |        306 |  0.6% |                ~77 |
| **합계**                       | **54,477** |  100% |        **~13,619** |

지배 요인은 **도구 정의(48%)**. 단, `instructions + toolDefinitions`는
`prompt_cache_key`로 캐시되는 **prefix material**
(`codex-request.ts` `buildProviderVisiblePrefixMaterial`)이라, 여러 턴에 걸쳐
사실상 **한 번만** 지불된다. 반면 **history(특히 도구 result)는 턴마다 누적**되는
비용이다. 즉 *한 요청의 raw 바이트*는 도구 정의가 크지만, *턴당 증가분*은 도구
result가 지배한다 — 그래서 아래 §3(오프로드)·§4(압축)가 한계 비용의 핵심이다.

### 2. 도구 호출부 (도구 정의 주입)

- 등록 도구 **30**개 중 **28개만**(`directHot`) 요청에 주입. 지연 빌트인 2개:
  `fetch_url`, `search_memory_index`. **모든 MCP 도구도 지연**된다.
- 주입 스키마 = **25,591 B**, 전체 빌트인 주입 시 = 26,854 B (빌트인만으로는 절감이 작음).
- 가장 무거운 스키마: `exec`(2.3 KiB), `manage_files`(1.9 KiB), `search_files`(1.8 KiB).

**핵심(지연의 실효 절감)** — 지연된 도구는 요청 `tools`에 **아무것도 남기지 않는다**
(요청측 대표 비용은 `tool_search` + `exec` 스키마뿐, 상수). 그래서 지연 풀이 커져도
주입 비용은 **불변**이다. 합성 MCP 스키마(~741 B/개) 스윕:

| 지연 MCP 도구 수 | 주입(불변) | 전량 주입 시 |     절감 |
| ---------------: | ---------: | -----------: | -------: |
|                0 |   25.0 KiB |     25.0 KiB |        0 |
|               10 |   25.0 KiB |     32.2 KiB |  7.2 KiB |
|               25 |   25.0 KiB |     43.1 KiB | 18.1 KiB |
|               50 |   25.0 KiB |     61.2 KiB | 36.2 KiB |
|              100 |   25.0 KiB |     97.5 KiB | 72.5 KiB |

→ 요청측 도구 비용은 `O(directHot) + 상수`. 연결된 MCP/지연 도구 수와 **무관**하게 평평하다.

### 3. 도구 result 주입 (full vs model-visible)

40 KiB(`DEFAULT_TOOL_OUTPUT_INLINE_MAX_BYTES`) 이하는 inline, 초과분은 참조
(`outputRef`) + 슬림 요약으로 오프로드된다. 모델이 보는 바이트를 실측:

| 도구         | full output | model-visible |  축소 | offloaded |
| ------------ | ----------: | ------------: | ----: | :-------: |
| read_file    |    16.1 KiB |      16.1 KiB |  0.0% |    no     |
| read_file    |   128.1 KiB |         741 B | 99.4% |    yes    |
| read_file    |   512.1 KiB |         741 B | 99.9% |    yes    |
| search_files |   137.2 KiB |         678 B | 99.5% |    yes    |
| exec         |   128.2 KiB |         597 B | 99.5% |    yes    |

→ 임계값 이하 도구 result는 **그대로** 주입(효율 기제 미적용), 초과 대용량은
**~600–740 B 참조로 99%+ 축소**. 대용량 output이 컨텍스트를 잠식하는 것을 막는 핵심.

### 4. 압축 타깃팅 (결정론적 회계)

`turns=6` 히스토리 15,472 B 중, 최근 2턴 tail(5,309 B)을 보존하면 **65.7%(10,164 B)**
가 압축 대상 prefix가 된다. 실제 요약 결과 크기는 **모델 호출이 필요**하므로 여기서는
측정하지 않는다(결정론적 프로브 범위 밖). 이 절은 "압축이 무엇을 얼마나 겨냥하는지"의
회계만 제공한다.

## 파라미터

| 옵션                                 | 기본값                   | 설명                                |
| ------------------------------------ | ------------------------ | ----------------------------------- |
| `--profile <root\|explorer\|worker>` | root                     | 시스템 프롬프트 프로파일            |
| `--turns <n>`                        | 6                        | 시나리오 히스토리의 도구 사용 턴 수 |
| `--result-bytes <csv>`               | 2048,16384,131072,524288 | §3 도구 result 크기                 |
| `--mcp-sweep <csv>`                  | 0,10,25,50,100           | §2 지연 MCP 도구 수 스윕            |
| `--keep-recent-turns <n>`            | 2                        | §4 보존 tail 턴 수                  |
| `--bytes-per-token <f>`              | 4                        | 토큰 추정 환산비(라벨링된 추정치)   |
| `--json`, `--out <path>`             | —                        | 기계용 JSON 출력/저장               |

## 한계

- 토큰은 추정치다. 정확한 토큰은 모델별 실측 보정비(또는 라이브 런)가 필요하다.
- §4의 실현 압축비, 그리고 provider 측 실제 `input_tokens`는 라이브 런에서만 나온다
  (본 프로브는 결정론적 오프라인 범위로 한정).
- §2의 MCP 스키마 크기는 대표값(~741 B)을 가정한 counterfactual이다. 실제 연결
  서버의 스키마 크기로 `--mcp-sweep`와 함께 대입해 볼 수 있다.
