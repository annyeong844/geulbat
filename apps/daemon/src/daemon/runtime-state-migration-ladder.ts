/**
 * 런타임 상태 스키마 사다리 — 적용된 단계는 정의상 동결된 이력이라 다시 바뀌지
 * 않는다. runtime-state-database.ts에서 분리했다(2026-07-25). 살아있는 열기 수준
 * 코드(백업·무결성·pragma·트랜잭션)가 과거 DDL 이력에 파묻히지 않게 하려는 것이다.
 *
 * 이 파일은 데이터만 소유한다. 사다리를 실제로 적용하는 주체는
 * runtime-state-database.ts의 runRuntimeStateMigrations다.
 */

/**
 * i번째 항목은 스키마 버전 i에서 i+1로 올리는 DDL이다. 배열 인덱스가 곧 출발
 * 버전이고, 사다리 길이가 곧 현재 스키마 버전(RUNTIME_STATE_SCHEMA_VERSION)이다.
 *
 * 새 단계는 끝에 붙이기만 한다 — 버전 상수를 따로 올릴 필요가 없다. 기존 항목은
 * 절대 수정하거나 중간에 끼워 넣지 않는다. 이미 적용된 DB가 다시 밟지 않기 때문에
 * 고쳐도 반영되지 않고, 새 DB와 기존 DB의 스키마만 갈라진다.
 *
 * 각 항목은 하나의 IMMEDIATE 트랜잭션 안에서 실행되고, 같은 트랜잭션에서
 * runtime_schema_migrations 행과 PRAGMA user_version이 함께 올라간다.
 */
export const RUNTIME_STATE_MIGRATION_LADDER: readonly string[] = [
  // v0 -> v1: 마이그레이션 이력 테이블을 만든다.
  `
            CREATE TABLE runtime_schema_migrations (
              version INTEGER PRIMARY KEY,
              applied_at TEXT NOT NULL
            ) STRICT;
          `,
  // v1 -> v2: subagent_launch_requests와 큐 순서 인덱스를 도입한다.
  `
            CREATE TABLE subagent_launch_requests (
              enqueue_order INTEGER PRIMARY KEY AUTOINCREMENT,
              child_run_id TEXT NOT NULL UNIQUE,
              child_thread_id TEXT NOT NULL UNIQUE,
              parent_run_id TEXT NOT NULL,
              owner_thread_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              batch_id TEXT,
              batch_position INTEGER NOT NULL CHECK (batch_position >= 0),
              launch_state TEXT NOT NULL CHECK (
                launch_state IN (
                  'queued',
                  'starting',
                  'started',
                  'cancelled',
                  'failed_to_start'
                )
              ),
              priority_class TEXT NOT NULL CHECK (priority_class = 'normal'),
              input_json TEXT NOT NULL,
              failure_reason TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (parent_run_id, tool_call_id)
            ) STRICT;

            CREATE INDEX subagent_launch_requests_queue_order
              ON subagent_launch_requests (
                launch_state,
                priority_class,
                enqueue_order
              );
          `,
  // v2 -> v3: priority_class를 'normal' 고정에서 low/normal/high로 넓힌다.
  `
            ALTER TABLE subagent_launch_requests
              RENAME TO subagent_launch_requests_v2;

            CREATE TABLE subagent_launch_requests (
              enqueue_order INTEGER PRIMARY KEY AUTOINCREMENT,
              child_run_id TEXT NOT NULL UNIQUE,
              child_thread_id TEXT NOT NULL UNIQUE,
              parent_run_id TEXT NOT NULL,
              owner_thread_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              batch_id TEXT,
              batch_position INTEGER NOT NULL CHECK (batch_position >= 0),
              launch_state TEXT NOT NULL CHECK (
                launch_state IN (
                  'queued',
                  'starting',
                  'started',
                  'cancelled',
                  'failed_to_start'
                )
              ),
              priority_class TEXT NOT NULL CHECK (
                priority_class IN ('low', 'normal', 'high')
              ),
              input_json TEXT NOT NULL,
              failure_reason TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (parent_run_id, tool_call_id)
            ) STRICT;

            INSERT INTO subagent_launch_requests (
              enqueue_order,
              child_run_id,
              child_thread_id,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              failure_reason,
              created_at,
              updated_at
            )
            SELECT
              enqueue_order,
              child_run_id,
              child_thread_id,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              failure_reason,
              created_at,
              updated_at
            FROM subagent_launch_requests_v2;

            DROP TABLE subagent_launch_requests_v2;

            CREATE INDEX subagent_launch_requests_queue_order
              ON subagent_launch_requests (
                launch_state,
                priority_class,
                enqueue_order
              );
          `,
  // v3 -> v4: defer_reason 열을 더한다.
  `
            ALTER TABLE subagent_launch_requests
              ADD COLUMN defer_reason TEXT CHECK (
                defer_reason IS NULL OR
                defer_reason IN (
                  'resource_budget',
                  'configured_capacity',
                  'provider_cooldown',
                  'main_reserve',
                  'batch_group_wait',
                  'recovery_reconciliation'
                )
              );
          `,
  // v4 -> v5: subagent_terminal_outcomes와 subagent_background_deliveries를 도입한다.
  `
            CREATE TABLE subagent_terminal_outcomes (
              child_run_id TEXT PRIMARY KEY,
              owner_thread_id TEXT NOT NULL,
              parent_run_id TEXT NOT NULL,
              child_thread_id TEXT,
              result_ref TEXT NOT NULL UNIQUE,
              terminal_state TEXT NOT NULL CHECK (
                terminal_state IN ('completed', 'failed', 'cancelled')
              ),
              terminal_reason TEXT CHECK (
                terminal_reason IS NULL OR terminal_reason IN (
                  'child_error',
                  'timeout',
                  'user_interrupt',
                  'sibling_error',
                  'explicit_stop'
                )
              ),
              completed_at TEXT NOT NULL,
              result_bytes INTEGER NOT NULL CHECK (result_bytes >= 0),
              payload_json TEXT NOT NULL,
              recorded_at TEXT NOT NULL
            ) STRICT;

            CREATE TABLE subagent_background_deliveries (
              delivery_id TEXT PRIMARY KEY,
              owner_thread_id TEXT NOT NULL,
              child_run_id TEXT NOT NULL UNIQUE REFERENCES
                subagent_terminal_outcomes (child_run_id) ON DELETE CASCADE,
              acknowledged_at TEXT,
              created_at TEXT NOT NULL
            ) STRICT;

            CREATE INDEX subagent_background_deliveries_pending
              ON subagent_background_deliveries (
                owner_thread_id,
                acknowledged_at,
                created_at
              );
          `,
  // v5 -> v6: launch_state에 'interrupted'를 더한다.
  `
            ALTER TABLE subagent_launch_requests
              RENAME TO subagent_launch_requests_v5;

            CREATE TABLE subagent_launch_requests (
              enqueue_order INTEGER PRIMARY KEY AUTOINCREMENT,
              child_run_id TEXT NOT NULL UNIQUE,
              child_thread_id TEXT NOT NULL UNIQUE,
              parent_run_id TEXT NOT NULL,
              owner_thread_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              batch_id TEXT,
              batch_position INTEGER NOT NULL CHECK (batch_position >= 0),
              launch_state TEXT NOT NULL CHECK (
                launch_state IN (
                  'queued',
                  'starting',
                  'started',
                  'interrupted',
                  'cancelled',
                  'failed_to_start'
                )
              ),
              priority_class TEXT NOT NULL CHECK (
                priority_class IN ('low', 'normal', 'high')
              ),
              input_json TEXT NOT NULL,
              defer_reason TEXT CHECK (
                defer_reason IS NULL OR
                defer_reason IN (
                  'resource_budget',
                  'configured_capacity',
                  'provider_cooldown',
                  'main_reserve',
                  'batch_group_wait',
                  'recovery_reconciliation'
                )
              ),
              failure_reason TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (parent_run_id, tool_call_id)
            ) STRICT;

            INSERT INTO subagent_launch_requests (
              enqueue_order,
              child_run_id,
              child_thread_id,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              defer_reason,
              failure_reason,
              created_at,
              updated_at
            )
            SELECT
              enqueue_order,
              child_run_id,
              child_thread_id,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              defer_reason,
              failure_reason,
              created_at,
              updated_at
            FROM subagent_launch_requests_v5;

            DROP TABLE subagent_launch_requests_v5;

            CREATE INDEX subagent_launch_requests_queue_order
              ON subagent_launch_requests (
                launch_state,
                priority_class,
                enqueue_order
              );
          `,
  // v6 -> v7: previous_child_run_id(재시도 체인)를 더한다.
  `
            ALTER TABLE subagent_launch_requests
              RENAME TO subagent_launch_requests_v6;

            CREATE TABLE subagent_launch_requests (
              enqueue_order INTEGER PRIMARY KEY AUTOINCREMENT,
              child_run_id TEXT NOT NULL UNIQUE,
              child_thread_id TEXT NOT NULL UNIQUE,
              previous_child_run_id TEXT UNIQUE REFERENCES
                subagent_launch_requests (child_run_id),
              parent_run_id TEXT NOT NULL,
              owner_thread_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              batch_id TEXT,
              batch_position INTEGER NOT NULL CHECK (batch_position >= 0),
              launch_state TEXT NOT NULL CHECK (
                launch_state IN (
                  'queued',
                  'starting',
                  'started',
                  'interrupted',
                  'cancelled',
                  'failed_to_start'
                )
              ),
              priority_class TEXT NOT NULL CHECK (
                priority_class IN ('low', 'normal', 'high')
              ),
              input_json TEXT NOT NULL,
              defer_reason TEXT CHECK (
                defer_reason IS NULL OR
                defer_reason IN (
                  'resource_budget',
                  'configured_capacity',
                  'provider_cooldown',
                  'main_reserve',
                  'batch_group_wait',
                  'recovery_reconciliation'
                )
              ),
              failure_reason TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (parent_run_id, tool_call_id)
            ) STRICT;

            INSERT INTO subagent_launch_requests (
              enqueue_order,
              child_run_id,
              child_thread_id,
              previous_child_run_id,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              defer_reason,
              failure_reason,
              created_at,
              updated_at
            )
            SELECT
              enqueue_order,
              child_run_id,
              child_thread_id,
              NULL,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              defer_reason,
              failure_reason,
              created_at,
              updated_at
            FROM subagent_launch_requests_v6;

            DROP TABLE subagent_launch_requests_v6;

            CREATE INDEX subagent_launch_requests_queue_order
              ON subagent_launch_requests (
                launch_state,
                priority_class,
                enqueue_order
              );
          `,
  // v7 -> v8: runtime_phase·last_tool_*·partial_output_available 관측 열을 도입하고,
  // terminal_reason을 provider/tool/persistence/daemon_restart까지 넓힌다.
  `
            ALTER TABLE subagent_launch_requests
              RENAME TO subagent_launch_requests_v7;

            CREATE TABLE subagent_launch_requests (
              enqueue_order INTEGER PRIMARY KEY AUTOINCREMENT,
              child_run_id TEXT NOT NULL UNIQUE,
              child_thread_id TEXT NOT NULL UNIQUE,
              previous_child_run_id TEXT UNIQUE REFERENCES
                subagent_launch_requests (child_run_id),
              parent_run_id TEXT NOT NULL,
              owner_thread_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              batch_id TEXT,
              batch_position INTEGER NOT NULL CHECK (batch_position >= 0),
              launch_state TEXT NOT NULL CHECK (
                launch_state IN (
                  'queued',
                  'starting',
                  'started',
                  'interrupted',
                  'cancelled',
                  'failed_to_start'
                )
              ),
              priority_class TEXT NOT NULL CHECK (
                priority_class IN ('low', 'normal', 'high')
              ),
              input_json TEXT NOT NULL,
              defer_reason TEXT CHECK (
                defer_reason IS NULL OR
                defer_reason IN (
                  'resource_budget',
                  'configured_capacity',
                  'provider_cooldown',
                  'main_reserve',
                  'batch_group_wait',
                  'recovery_reconciliation'
                )
              ),
              failure_reason TEXT,
              runtime_phase TEXT NOT NULL CHECK (
                runtime_phase IN (
                  'queued',
                  'starting',
                  'provider_waiting',
                  'provider_streaming',
                  'tool_running',
                  'approval_pending'
                )
              ),
              last_activity_at TEXT NOT NULL,
              last_tool_name TEXT,
              last_tool_call_id TEXT,
              last_tool_state TEXT CHECK (
                last_tool_state IS NULL OR
                last_tool_state IN ('running', 'succeeded', 'failed')
              ),
              partial_output_available INTEGER NOT NULL CHECK (
                partial_output_available IN (0, 1)
              ),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (parent_run_id, tool_call_id),
              CHECK (
                (last_tool_name IS NULL) =
                (last_tool_call_id IS NULL)
              ),
              CHECK (
                (last_tool_name IS NULL) =
                (last_tool_state IS NULL)
              )
            ) STRICT;

            INSERT INTO subagent_launch_requests (
              enqueue_order,
              child_run_id,
              child_thread_id,
              previous_child_run_id,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              defer_reason,
              failure_reason,
              runtime_phase,
              last_activity_at,
              last_tool_name,
              last_tool_call_id,
              last_tool_state,
              partial_output_available,
              created_at,
              updated_at
            )
            SELECT
              enqueue_order,
              child_run_id,
              child_thread_id,
              previous_child_run_id,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              defer_reason,
              failure_reason,
              CASE launch_state
                WHEN 'queued' THEN 'queued'
                WHEN 'starting' THEN 'starting'
                WHEN 'started' THEN 'provider_waiting'
                WHEN 'interrupted' THEN 'provider_waiting'
                ELSE 'queued'
              END,
              updated_at,
              NULL,
              NULL,
              NULL,
              0,
              created_at,
              updated_at
            FROM subagent_launch_requests_v7
            ORDER BY enqueue_order;

            DROP TABLE subagent_launch_requests_v7;

            CREATE INDEX subagent_launch_requests_queue_order
              ON subagent_launch_requests (
                launch_state,
                priority_class,
                enqueue_order
              );

            ALTER TABLE subagent_background_deliveries
              RENAME TO subagent_background_deliveries_v7;
            ALTER TABLE subagent_terminal_outcomes
              RENAME TO subagent_terminal_outcomes_v7;

            CREATE TABLE subagent_terminal_outcomes (
              child_run_id TEXT PRIMARY KEY,
              owner_thread_id TEXT NOT NULL,
              parent_run_id TEXT NOT NULL,
              child_thread_id TEXT,
              result_ref TEXT NOT NULL UNIQUE,
              terminal_state TEXT NOT NULL CHECK (
                terminal_state IN ('completed', 'failed', 'cancelled')
              ),
              terminal_reason TEXT CHECK (
                terminal_reason IS NULL OR terminal_reason IN (
                  'child_error',
                  'provider_error',
                  'tool_error',
                  'persistence_error',
                  'daemon_restart',
                  'timeout',
                  'user_interrupt',
                  'sibling_error',
                  'explicit_stop'
                )
              ),
              completed_at TEXT NOT NULL,
              result_bytes INTEGER NOT NULL CHECK (result_bytes >= 0),
              payload_json TEXT NOT NULL,
              recorded_at TEXT NOT NULL
            ) STRICT;

            CREATE TABLE subagent_background_deliveries (
              delivery_id TEXT PRIMARY KEY,
              owner_thread_id TEXT NOT NULL,
              child_run_id TEXT NOT NULL UNIQUE REFERENCES
                subagent_terminal_outcomes (child_run_id) ON DELETE CASCADE,
              acknowledged_at TEXT,
              created_at TEXT NOT NULL
            ) STRICT;

            INSERT INTO subagent_terminal_outcomes
            SELECT * FROM subagent_terminal_outcomes_v7;

            INSERT INTO subagent_background_deliveries
            SELECT * FROM subagent_background_deliveries_v7;

            DROP TABLE subagent_background_deliveries_v7;
            DROP TABLE subagent_terminal_outcomes_v7;

            CREATE INDEX subagent_background_deliveries_pending
              ON subagent_background_deliveries (
                owner_thread_id,
                acknowledged_at,
                created_at
              );
          `,
  // v8 -> v9: runtime_phase에 'auth_waiting'과 'rate_limit_waiting'을 더한다.
  `
            ALTER TABLE subagent_launch_requests
              RENAME TO subagent_launch_requests_v8;

            CREATE TABLE subagent_launch_requests (
              enqueue_order INTEGER PRIMARY KEY AUTOINCREMENT,
              child_run_id TEXT NOT NULL UNIQUE,
              child_thread_id TEXT NOT NULL UNIQUE,
              previous_child_run_id TEXT UNIQUE REFERENCES
                subagent_launch_requests (child_run_id),
              parent_run_id TEXT NOT NULL,
              owner_thread_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              batch_id TEXT,
              batch_position INTEGER NOT NULL CHECK (batch_position >= 0),
              launch_state TEXT NOT NULL CHECK (
                launch_state IN (
                  'queued',
                  'starting',
                  'started',
                  'interrupted',
                  'cancelled',
                  'failed_to_start'
                )
              ),
              priority_class TEXT NOT NULL CHECK (
                priority_class IN ('low', 'normal', 'high')
              ),
              input_json TEXT NOT NULL,
              defer_reason TEXT CHECK (
                defer_reason IS NULL OR
                defer_reason IN (
                  'resource_budget',
                  'configured_capacity',
                  'provider_cooldown',
                  'main_reserve',
                  'batch_group_wait',
                  'recovery_reconciliation'
                )
              ),
              failure_reason TEXT,
              runtime_phase TEXT NOT NULL CHECK (
                runtime_phase IN (
                  'queued',
                  'starting',
                  'auth_waiting',
                  'provider_waiting',
                  'rate_limit_waiting',
                  'provider_streaming',
                  'tool_running',
                  'approval_pending'
                )
              ),
              last_activity_at TEXT NOT NULL,
              last_tool_name TEXT,
              last_tool_call_id TEXT,
              last_tool_state TEXT CHECK (
                last_tool_state IS NULL OR
                last_tool_state IN ('running', 'succeeded', 'failed')
              ),
              partial_output_available INTEGER NOT NULL CHECK (
                partial_output_available IN (0, 1)
              ),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (parent_run_id, tool_call_id),
              CHECK (
                (last_tool_name IS NULL) =
                (last_tool_call_id IS NULL)
              ),
              CHECK (
                (last_tool_name IS NULL) =
                (last_tool_state IS NULL)
              )
            ) STRICT;

            INSERT INTO subagent_launch_requests (
              enqueue_order,
              child_run_id,
              child_thread_id,
              previous_child_run_id,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              defer_reason,
              failure_reason,
              runtime_phase,
              last_activity_at,
              last_tool_name,
              last_tool_call_id,
              last_tool_state,
              partial_output_available,
              created_at,
              updated_at
            )
            SELECT
              enqueue_order,
              child_run_id,
              child_thread_id,
              previous_child_run_id,
              parent_run_id,
              owner_thread_id,
              tool_call_id,
              batch_id,
              batch_position,
              launch_state,
              priority_class,
              input_json,
              defer_reason,
              failure_reason,
              runtime_phase,
              last_activity_at,
              last_tool_name,
              last_tool_call_id,
              last_tool_state,
              partial_output_available,
              created_at,
              updated_at
            FROM subagent_launch_requests_v8
            ORDER BY enqueue_order;

            DROP TABLE subagent_launch_requests_v8;

            CREATE INDEX subagent_launch_requests_queue_order
              ON subagent_launch_requests (
                launch_state,
                priority_class,
                enqueue_order
              );
          `,
  // v9 -> v10: terminal_reason에 'daemon_shutdown'을 더한다.
  `
            ALTER TABLE subagent_background_deliveries
              RENAME TO subagent_background_deliveries_v9;
            ALTER TABLE subagent_terminal_outcomes
              RENAME TO subagent_terminal_outcomes_v9;

            CREATE TABLE subagent_terminal_outcomes (
              child_run_id TEXT PRIMARY KEY,
              owner_thread_id TEXT NOT NULL,
              parent_run_id TEXT NOT NULL,
              child_thread_id TEXT,
              result_ref TEXT NOT NULL UNIQUE,
              terminal_state TEXT NOT NULL CHECK (
                terminal_state IN ('completed', 'failed', 'cancelled')
              ),
              terminal_reason TEXT CHECK (
                terminal_reason IS NULL OR terminal_reason IN (
                  'child_error',
                  'provider_error',
                  'tool_error',
                  'persistence_error',
                  'daemon_restart',
                  'daemon_shutdown',
                  'timeout',
                  'user_interrupt',
                  'sibling_error',
                  'explicit_stop'
                )
              ),
              completed_at TEXT NOT NULL,
              result_bytes INTEGER NOT NULL CHECK (result_bytes >= 0),
              payload_json TEXT NOT NULL,
              recorded_at TEXT NOT NULL
            ) STRICT;

            CREATE TABLE subagent_background_deliveries (
              delivery_id TEXT PRIMARY KEY,
              owner_thread_id TEXT NOT NULL,
              child_run_id TEXT NOT NULL UNIQUE REFERENCES
                subagent_terminal_outcomes (child_run_id) ON DELETE CASCADE,
              acknowledged_at TEXT,
              created_at TEXT NOT NULL
            ) STRICT;

            INSERT INTO subagent_terminal_outcomes
            SELECT * FROM subagent_terminal_outcomes_v9;

            INSERT INTO subagent_background_deliveries
            SELECT * FROM subagent_background_deliveries_v9;

            DROP TABLE subagent_background_deliveries_v9;
            DROP TABLE subagent_terminal_outcomes_v9;

            CREATE INDEX subagent_background_deliveries_pending
              ON subagent_background_deliveries (
                owner_thread_id,
                acknowledged_at,
                created_at
              );
          `,
  // v10 -> v11: provider_request_json 열을 더한다.
  `
            ALTER TABLE subagent_launch_requests
              ADD COLUMN provider_request_json TEXT;
          `,
  // v11 -> v12: settled run usage를 run identity별로 보존한다.
  `
            CREATE TABLE run_usage_records (
              run_id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL,
              model_id TEXT NOT NULL,
              provider_id TEXT,
              input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
              output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
              cached_input_tokens INTEGER NOT NULL CHECK (
                cached_input_tokens >= 0
              ),
              settled_at TEXT NOT NULL,
              recorded_at TEXT NOT NULL
            ) STRICT;

            CREATE INDEX run_usage_records_settled_at
              ON run_usage_records (settled_at);
          `,
  // v12 -> v13: run_usage_records를 되돌린다. v12는 이미 적용된 이력이라
  // 지울 수 없으므로(사다리 규칙) 앞으로 가는 단계로 제거한다. 사용량은
  // 로컬에서 토큰을 세는 대신 제공자가 보고하는 값을 그때그때 조회하는 쪽으로
  // 방향이 바뀌었고, 이 테이블은 쓰는 코드 없이 비어 있었다.
  `
            DROP INDEX IF EXISTS run_usage_records_settled_at;
            DROP TABLE IF EXISTS run_usage_records;
          `,
  // v13 -> v14: 데몬 재시작 뒤 command-host MCP 세션을 재입양할 최소 좌표.
  // offset은 이전 요청의 응답을 새 SDK client에 재생하지 않도록 저장하지 않는다.
  `
            CREATE TABLE mcp_session_coordinates (
              server_id TEXT PRIMARY KEY,
              output_ref TEXT NOT NULL
            ) STRICT;
          `,
];
