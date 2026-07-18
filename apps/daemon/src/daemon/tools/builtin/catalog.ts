import { agentSendInputTool } from './agent-send-input.js';
import { askUserTool } from './ask-user.js';
import { agentSpawnTool } from './agent-spawn.js';
import { agentStopTool } from './agent-stop.js';
import { agentWaitTool } from './agent-wait.js';
import { browserPageLoadEvidenceTool } from './browser-page-load-evidence.js';
import { browserTextEvidenceTool } from './browser-text-evidence.js';
import { browserNavigateTool } from './browser-navigate.js';
import { execCommandTool } from './exec-command.js';
import { executeCodeTool } from './execute-code.js';
import { generateImageTool } from './image-generation.js';
import { generateVideoTool } from './video-generation.js';
import { installPackagesTool } from './install-packages.js';
import { listFilesTool } from './list-files.js';
import { manageFilesTool } from './manage-files.js';
import { applyPatchTool } from './apply-patch.js';
import { readFileTool } from './read-file.js';
import { readToolOutputTool } from './read-tool-output.js';
import { refreshMemoryIndexTool } from './refresh-memory-index.js';
import { searchFilesTool } from './search-files.js';
import { searchMemoryIndexTool } from './search-memory-index.js';
import { skillSearchTool } from './skill-search.js';
import { buildToolSearchCatalog, createToolSearchTool } from './tool-search.js';
import { updatePlanTool } from './update-plan.js';
import { visualizeTool } from './visualize.js';
import { waitTool } from './wait.js';
import { fetchUrlTool } from './web-fetch.js';
import { writeFileTool } from './write-file.js';
import {
  createToolRegistryStore,
  type ToolRegistryStore,
} from '../registry.js';
import type { AnyTool } from '../types.js';

interface CreateBuiltinToolRegistryStoreOptions {
  // Operator package-install opt-in (GEULBAT_PTC_PACKAGE_INSTALL_ENABLED):
  // without it, install_packages is absent from the registry, not merely
  // rejected at execution time.
  includeInstallPackagesTool?: boolean;
}

function getCanonicalBuiltinTools(
  options: CreateBuiltinToolRegistryStoreOptions,
): readonly AnyTool[] {
  const tools = [
    readFileTool,
    listFilesTool,
    searchFilesTool,
    applyPatchTool,
    writeFileTool,
    manageFilesTool,
    updatePlanTool,
    visualizeTool,
    askUserTool,
    readToolOutputTool,
    agentSpawnTool,
    agentSendInputTool,
    agentStopTool,
    agentWaitTool,
    refreshMemoryIndexTool,
    searchMemoryIndexTool,
    skillSearchTool,
    fetchUrlTool,
    generateImageTool,
    generateVideoTool,
    browserNavigateTool,
    browserPageLoadEvidenceTool,
    browserTextEvidenceTool,
    execCommandTool,
    executeCodeTool,
    ...(options.includeInstallPackagesTool === true
      ? [installPackagesTool]
      : []),
    waitTool,
  ];
  const toolSearchTool = createToolSearchTool({
    getCatalog: () => buildToolSearchCatalog([...tools, toolSearchTool]),
  });
  return [...tools, toolSearchTool];
}

export function createBuiltinToolRegistryStore(
  options: CreateBuiltinToolRegistryStoreOptions = {},
): ToolRegistryStore {
  return createToolRegistryStore({
    builtins: getCanonicalBuiltinTools(options),
  });
}
