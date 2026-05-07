import { ProjectWorkspace } from './ProjectWorkspace.js';
import { useAppShell } from './use-app-shell.js';
import './App.css';

export function App() {
  const appShell = useAppShell();

  return (
    <>
      <ProjectWorkspace
        key={appShell.workspaceKey}
        {...appShell.workspaceProps}
      />
      {appShell.providerAuthNotice ? (
        <div className="app-toast" role="status" aria-live="polite">
          {appShell.providerAuthNotice}
        </div>
      ) : null}
    </>
  );
}
