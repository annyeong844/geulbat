import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createLogger } from '@geulbat/shared-utils/logger';

const logger = createLogger('app-error-boundary');

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    logger.error('uncaught render error:', error, errorInfo.componentStack);
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <main className="app-error-boundary" role="alert" aria-live="assertive">
        <div className="app-error-boundary-card">
          <h1 className="app-error-boundary-title">
            앱이 예기치 않게 중단되었습니다.
          </h1>
          <p className="app-error-boundary-text">
            현재 화면을 더 안전하게 복구할 수 없어서 새로고침이 필요합니다.
          </p>
          <button
            type="button"
            className="app-error-boundary-action"
            onClick={this.handleReload}
          >
            새로고침
          </button>
        </div>
      </main>
    );
  }
}
