import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from './app/AppErrorBoundary';
import { App } from './app/App';
import { startUiResponsivenessObserver } from './app/ui-performance-diagnostics';

const uiResponsivenessObserver = startUiResponsivenessObserver();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    uiResponsivenessObserver?.disconnect();
  });
}

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
