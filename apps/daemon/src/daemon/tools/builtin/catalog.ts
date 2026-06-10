import { agentSendInputTool } from './agent-send-input.js';
import { agentSpawnTool } from './agent-spawn.js';
import { agentStopTool } from './agent-stop.js';
import { agentWaitTool } from './agent-wait.js';
import { browserNavigateTool } from './browser-navigate.js';
import { executeCodeTool } from './execute-code.js';
import { listFilesTool } from './list-files.js';
import { manageFilesTool } from './manage-files.js';
import { patchFileTool } from './patch-file.js';
import { readFileTool } from './read-file.js';
import { readToolOutputTool } from './read-tool-output.js';
import { refreshMemoryIndexTool } from './refresh-memory-index.js';
import { searchFilesTool } from './search-files.js';
import { searchMemoryIndexTool } from './search-memory-index.js';
import { todoTool } from './todo.js';
import { webFetchTool } from './web-fetch.js';
import { writeFileTool } from './write-file.js';
import {
  createToolRegistryStore,
  type ToolRegistryStore,
} from '../registry.js';
import type { AnyTool } from '../types.js';

function getCanonicalBuiltinTools(): readonly AnyTool[] {
  return [
    readFileTool,
    listFilesTool,
    searchFilesTool,
    patchFileTool,
    writeFileTool,
    manageFilesTool,
    todoTool,
    readToolOutputTool,
    agentSpawnTool,
    agentSendInputTool,
    agentStopTool,
    agentWaitTool,
    refreshMemoryIndexTool,
    searchMemoryIndexTool,
    webFetchTool,
    browserNavigateTool,
    executeCodeTool,
  ];
}

export function createBuiltinToolRegistryStore(): ToolRegistryStore {
  return createToolRegistryStore({
    builtins: getCanonicalBuiltinTools(),
  });
}
