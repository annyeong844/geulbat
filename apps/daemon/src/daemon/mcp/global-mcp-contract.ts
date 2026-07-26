/**
 * 데몬이 다시 뜬 뒤 살아 있는 command-host MCP 세션을 찾는 최소 좌표.
 *
 * 읽기 offset은 일부러 없다. 이전 데몬이 읽지 못한 stdout은 이전 요청에 대한
 * 응답이므로 새 SDK client에 전달하면 안 되고, 재입양 시점의 stream end에서
 * 새 좌표계를 시작한다(P7.6 §7.2).
 */
export interface McpSessionCoordinate {
  serverId: string;
  outputRef: string;
}

export interface McpSessionCoordinateStore {
  readMcpSessionCoordinate(serverId: string): McpSessionCoordinate | undefined;
  persistMcpSessionCoordinate(coordinate: McpSessionCoordinate): void;
  deleteMcpSessionCoordinate(serverId: string): void;
}

export class McpServerNotFoundError extends Error {
  constructor(serverId: string) {
    super(`MCP server not found: ${serverId}`);
    this.name = 'McpServerNotFoundError';
  }
}

export class McpServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpServerConfigError';
  }
}

export class McpServerOwnershipError extends Error {
  constructor(serverId: string) {
    super(
      `Plugin-provided MCP server must be removed with its plugin: ${serverId}`,
    );
    this.name = 'McpServerOwnershipError';
  }
}
