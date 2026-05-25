import { useEffect, useState } from 'react';

import type { ArtifactTab } from './types.js';

interface ArtifactPaneTabState {
  tab: ArtifactTab;
  handleSelectTab: (tab: ArtifactTab) => void;
}

export function useArtifactPaneTabState(args: {
  artifactSessionKey: string;
  defaultTab: ArtifactTab;
}): ArtifactPaneTabState {
  const { artifactSessionKey, defaultTab } = args;
  const [tab, setTab] = useState<ArtifactTab>(defaultTab);

  useEffect(() => {
    setTab(defaultTab);
  }, [artifactSessionKey, defaultTab]);

  return {
    tab,
    handleSelectTab: setTab,
  };
}
