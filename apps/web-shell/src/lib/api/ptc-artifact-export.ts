import {
  isPtcArtifactExportSettingsStatus,
  type PtcArtifactExportPolicy,
  type PtcArtifactExportSettingsStatus,
} from '@geulbat/protocol/ptc-artifacts';

import { apiFetch } from './client.js';

export interface PtcArtifactExportSettingsClient {
  getStatus(): Promise<PtcArtifactExportSettingsStatus>;
  enable(
    policy: PtcArtifactExportPolicy,
  ): Promise<PtcArtifactExportSettingsStatus>;
  disable(): Promise<PtcArtifactExportSettingsStatus>;
}

export const ptcArtifactExportSettingsClient: PtcArtifactExportSettingsClient =
  {
    getStatus: () =>
      apiFetch(
        '/api/ptc-artifact-export/status',
        undefined,
        isPtcArtifactExportSettingsStatus,
      ),
    enable: (policy) =>
      apiFetch(
        '/api/ptc-artifact-export/enable',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(policy),
        },
        isPtcArtifactExportSettingsStatus,
      ),
    disable: () =>
      apiFetch(
        '/api/ptc-artifact-export/disable',
        { method: 'POST' },
        isPtcArtifactExportSettingsStatus,
      ),
  };
