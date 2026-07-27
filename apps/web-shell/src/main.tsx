import { createRoot } from 'react-dom/client';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/noto-serif-kr/wght.css';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { AppErrorBoundary } from './app/AppErrorBoundary';
import { App } from './app/App';
import { startUiResponsivenessObserver } from './app/ui-performance-diagnostics';

// 관찰자는 문서가 사는 동안 산다. HMR로 모듈만 교체되는 위상이 있었을 때는
// 그때 끊어줄 곳이 필요했지만, 지금 shell은 빌드 산출물로만 실행되므로 교체
// 단위가 문서 하나다: 새로고침이 관찰자까지 함께 버린다.
startUiResponsivenessObserver();

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
