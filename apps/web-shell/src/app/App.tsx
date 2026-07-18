import { HomeShell } from './HomeShell.js';
import { useAppShell } from './use-app-shell.js';
import './App.css';

export function App() {
  const appShell = useAppShell();

  return (
    <>
      <HomeShell {...appShell.homeProps} />
      {appShell.providerAuthNotice ? (
        <div className="app-toast" role="status" aria-live="polite">
          {appShell.providerAuthNotice}
        </div>
      ) : null}
    </>
  );
}
