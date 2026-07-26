import { agentSendInputTool } from './agent-send-input.js';
import { agentSetPriorityTool } from './agent-set-priority.js';
import { agentRetryTool } from './agent-retry.js';
import { askUserTool } from './ask-user.js';
import { agentSpawnTool } from './agent-spawn.js';
import { agentStopTool } from './agent-stop.js';
import { agentWaitTool } from './agent-wait.js';
import { browserPageLoadEvidenceTool } from './browser-page-load-evidence.js';
import { browserTextEvidenceTool } from './browser-text-evidence.js';
import { browserNavigateTool } from './browser-navigate.js';
import { citeMemoryTool } from './cite-memory.js';
import { execCommandTool } from './exec-command.js';
import { listCommandsTool } from './list-commands.js';
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
import { writeMemoryNoteTool } from './write-memory-note.js';
import { skillSearchTool } from './skill-search.js';
import { buildToolSearchCatalog, createToolSearchTool } from './tool-search.js';
import { suggestFollowupTool } from './suggest-followup.js';
import { proposePlanTool } from './propose-plan.js';
import { updatePlanTool } from './update-plan.js';
import { updateGoalTool } from './update-goal.js';
import { setThreadTitleTool } from './set-thread-title.js';
import { visualizeTool } from './visualize.js';
import { waitTool } from './wait.js';
import { fetchUrlTool } from './web-fetch.js';
import { writeStdinTool } from './write-stdin.js';
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
    proposePlanTool,
    updatePlanTool,
    updateGoalTool,
    suggestFollowupTool,
    setThreadTitleTool,
    visualizeTool,
    askUserTool,
    readToolOutputTool,
    agentSpawnTool,
    agentSendInputTool,
    agentSetPriorityTool,
    agentRetryTool,
    agentStopTool,
    agentWaitTool,
    refreshMemoryIndexTool,
    searchMemoryIndexTool,
    writeMemoryNoteTool,
    citeMemoryTool,
    skillSearchTool,
    fetchUrlTool,
    generateImageTool,
    generateVideoTool,
    browserNavigateTool,
    browserPageLoadEvidenceTool,
    browserTextEvidenceTool,
    execCommandTool,
    writeStdinTool,
    listCommandsTool,
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
