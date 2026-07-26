import { createRoot } from 'react-dom/client';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/noto-serif-kr/wght.css';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
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
