import { useEffect } from 'react';
import type { FileTreeNode } from '@geulbat/protocol/files';
import {
  getProjectTreeListStyle,
  projectTreeAlertStyle,
  projectTreeStyles,
} from './project-tree-styles.js';

interface Props {
  tree: FileTreeNode[];
  uiError?: string | null;
  onLoad: () => Promise<void> | void;
  onSelect: (path: string) => Promise<void> | void;
}

export function ProjectTree({ tree, uiError, onLoad, onSelect }: Props) {
  useEffect(() => {
    void onLoad();
  }, [onLoad]);

  return (
    <section className="project-tree">
      <h3>Project</h3>
      {uiError ? (
        <div style={projectTreeAlertStyle} role="alert">
          {uiError}
        </div>
      ) : null}
      {tree.length === 0 ? (
        <p style={projectTreeStyles.emptyState}>No files</p>
      ) : (
        <TreeNodes nodes={tree} onSelect={onSelect} depth={0} />
      )}
    </section>
  );
}

function TreeNodes({
  nodes,
  onSelect,
  depth,
}: {
  nodes: FileTreeNode[];
  onSelect: (path: string) => Promise<void> | void;
  depth: number;
}) {
  return (
    <ul style={getProjectTreeListStyle(depth)}>
      {nodes.map((node) => (
        <li key={node.path}>
          {node.type === 'directory' ? (
            <details open={depth < 2}>
              <summary style={projectTreeStyles.directorySummary}>
                {node.name}/
              </summary>
              {node.children && (
                <TreeNodes
                  nodes={node.children}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
              )}
            </details>
          ) : (
            <button
              onClick={() => void onSelect(node.path)}
              style={projectTreeStyles.fileButton}
            >
              {node.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
