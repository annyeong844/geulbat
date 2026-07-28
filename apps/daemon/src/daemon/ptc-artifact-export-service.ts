import type { FileHandle } from 'node:fs/promises';

import type {
  PtcArtifactExportPolicy,
  PtcArtifactExportSettingsStatus,
} from '@geulbat/protocol/ptc-artifacts';

import {
  openSandboxOutputEvidenceFile,
  SandboxOutputEvidenceReadError,
} from './sandbox/output-evidence-store.js';
import {
  clearStoredPtcArtifactExportPolicy,
  resolvePtcArtifactExportPolicy,
  writeStoredPtcArtifactExportPolicy,
} from './ptc/artifacts/artifact-export-policy-record.js';

interface PtcArtifactExportFile {
  handle: FileHandle;
  relativePath: string;
  bytes: number;
  sha256: string;
}

type PtcArtifactExportFileOpenResult =
  | { ok: true; value: PtcArtifactExportFile }
  | {
      ok: false;
      reasonCode: 'invalid_ref' | 'not_found' | 'file_not_found';
    };

const PTC_ARTIFACT_EVIDENCE_JOB_KIND =
  'ptc_execute_code_artifact_export' as const;

export interface PtcArtifactExportServicePort {
  getStatus: () => Promise<PtcArtifactExportSettingsStatus>;
  savePolicy: (policy: PtcArtifactExportPolicy) => Promise<void>;
  clearPolicy: () => Promise<void>;
  openFile: (args: {
    evidenceRef: string;
    relativePath: string;
  }) => Promise<PtcArtifactExportFileOpenResult>;
}

export function createPtcArtifactExportService(deps: {
  homeStateRoot: string;
}): PtcArtifactExportServicePort {
  return {
    getStatus: () => {
      const resolved = resolvePtcArtifactExportPolicy({
        homeStateRoot: deps.homeStateRoot,
      });
      if (resolved.policy === undefined) {
        return Promise.resolve({ state: 'disabled' });
      }
      return Promise.resolve({
        state: 'ready',
        source: resolved.source === 'environment' ? 'environment' : 'stored',
        policy: resolved.policy,
      });
    },
    savePolicy: (policy) =>
      writeStoredPtcArtifactExportPolicy({
        homeStateRoot: deps.homeStateRoot,
        policy,
      }),
    clearPolicy: () => clearStoredPtcArtifactExportPolicy(deps.homeStateRoot),
    async openFile(args) {
      try {
        return {
          ok: true,
          value: await openSandboxOutputEvidenceFile({
            workspaceRoot: deps.homeStateRoot,
            evidenceRef: args.evidenceRef,
            relativePath: args.relativePath,
            expectedJobKind: PTC_ARTIFACT_EVIDENCE_JOB_KIND,
          }),
        };
      } catch (error: unknown) {
        if (
          error instanceof SandboxOutputEvidenceReadError &&
          (error.reasonCode === 'invalid_ref' ||
            error.reasonCode === 'not_found' ||
            error.reasonCode === 'file_not_found')
        ) {
          return { ok: false, reasonCode: error.reasonCode };
        }
        throw error;
      }
    },
  };
}
