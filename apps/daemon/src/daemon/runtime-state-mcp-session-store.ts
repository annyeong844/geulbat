import type { DatabaseSync } from 'node:sqlite';

import type { McpSessionCoordinate } from './mcp/global-mcp-contract.js';
import { isRecord } from './runtime-json.js';

export function readMcpSessionCoordinate(
  database: DatabaseSync,
  serverId: string,
): McpSessionCoordinate | undefined {
  assertNonEmptyCoordinateField(serverId, 'serverId');
  const row = database
    .prepare(
      `
        SELECT
          server_id AS serverId,
          output_ref AS outputRef
        FROM mcp_session_coordinates
        WHERE server_id = ?
      `,
    )
    .get(serverId);
  if (row === undefined) {
    return undefined;
  }
  if (
    !isRecord(row) ||
    typeof row['serverId'] !== 'string' ||
    typeof row['outputRef'] !== 'string' ||
    row['serverId'].length === 0 ||
    row['outputRef'].length === 0
  ) {
    throw new Error('persisted MCP session coordinate is invalid');
  }
  return {
    serverId: row['serverId'],
    outputRef: row['outputRef'],
  };
}

export function persistMcpSessionCoordinate(
  database: DatabaseSync,
  coordinate: McpSessionCoordinate,
): void {
  assertNonEmptyCoordinateField(coordinate.serverId, 'serverId');
  assertNonEmptyCoordinateField(coordinate.outputRef, 'outputRef');
  database
    .prepare(
      `
        INSERT INTO mcp_session_coordinates (server_id, output_ref)
        VALUES (?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          output_ref = excluded.output_ref
      `,
    )
    .run(coordinate.serverId, coordinate.outputRef);
}

export function deleteMcpSessionCoordinate(
  database: DatabaseSync,
  serverId: string,
): void {
  assertNonEmptyCoordinateField(serverId, 'serverId');
  database
    .prepare('DELETE FROM mcp_session_coordinates WHERE server_id = ?')
    .run(serverId);
}

function assertNonEmptyCoordinateField(
  value: string,
  field: 'outputRef' | 'serverId',
): void {
  if (value.length === 0) {
    throw new Error(`MCP session coordinate ${field} must not be empty`);
  }
}
