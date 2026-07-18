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
