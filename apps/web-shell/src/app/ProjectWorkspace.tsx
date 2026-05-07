import { ProjectRegistryManager } from '../features/project-selector/ProjectRegistryManager.js';
import { ProjectSelector } from '../features/project-selector/ProjectSelector.js';
import { ProjectTree } from '../features/project-tree/ProjectTree.js';
import { ThreadList } from '../features/thread-list/ThreadList.js';
import { ThreadDeleteConfirm } from '../features/thread-list/ThreadDeleteConfirm.js';
import { Editor } from '../features/editor/Editor.js';
import { Assistant } from '../features/assistant/Assistant.js';
import { Approvals } from '../features/approvals/Approvals.js';
import { ProviderAuthCard } from '../features/provider-auth/ProviderAuthCard.js';
import type { ProjectWorkspaceProps } from './project-workspace-shell.js';
import { useProjectWorkspaceShell } from './use-project-workspace-shell.js';

export function ProjectWorkspace(props: ProjectWorkspaceProps) {
  const { leftPanelView, centerPanelView, rightPanelView } =
    useProjectWorkspaceShell(props);

  return (
    <div className="app-layout">
      <aside className="panel-left">
        <ProjectSelector {...leftPanelView.projectSelector} />
        <ProjectRegistryManager {...leftPanelView.projectRegistry} />
        <ProjectTree {...leftPanelView.projectTree} />
        <ThreadList {...leftPanelView.threadList} />
        {leftPanelView.threadDeleteConfirm ? (
          <ThreadDeleteConfirm {...leftPanelView.threadDeleteConfirm} />
        ) : null}
      </aside>
      <main className="panel-center">
        <Editor {...centerPanelView.editor} />
      </main>
      <aside className="panel-right">
        <ProviderAuthCard {...rightPanelView.providerAuthCard} />
        <Assistant
          {...rightPanelView.assistant}
          approvalPanel={<Approvals {...rightPanelView.approvalPanel} />}
        />
      </aside>
    </div>
  );
}
