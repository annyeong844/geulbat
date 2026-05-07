type ProjectTreeRefreshPhase = 'idle' | 'running' | 'queued';

export function createProjectTreeRefreshController(): {
  request(loadTree: () => Promise<void> | void): Promise<void>;
  clearQueuedRefresh(): void;
  readPhase(): 'idle' | 'running' | 'queued';
} {
  let phase: ProjectTreeRefreshPhase = 'idle';
  let inFlight: Promise<void> | null = null;
  const hasQueuedRefresh = () => phase === 'queued';

  const flush = (loadTree: () => Promise<void> | void): Promise<void> => {
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        while (phase === 'running' || phase === 'queued') {
          phase = 'running';
          await loadTree();
          if (!hasQueuedRefresh()) {
            break;
          }
        }
      } finally {
        phase = 'idle';
        inFlight = null;
      }
    })();

    return inFlight;
  };

  return {
    request(loadTree) {
      phase = phase === 'idle' ? 'running' : 'queued';
      return flush(loadTree);
    },
    clearQueuedRefresh() {
      if (phase === 'queued') {
        phase = 'running';
      }
    },
    readPhase() {
      return phase;
    },
  };
}

export function requestProjectTreeRefresh(
  controller: ReturnType<typeof createProjectTreeRefreshController>,
  loadTree: () => Promise<void> | void,
): Promise<void> {
  return controller.request(loadTree);
}
