import {
  PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID,
  PTC_BROWSER_TEXT_EVIDENCE_MAX_TIMEOUT_MS,
  type PtcBrowserTextEvidenceRuntime,
  type PtcBrowserTextEvidenceRuntimeCleanupResult,
  type PtcBrowserTextEvidenceRuntimeResult,
} from './browser-text-evidence-runtime-contract.js';
import {
  admitPtcBrowserWorkspaceRuntime,
  createPtcBrowserWorkspaceRuntimeOwner,
  type PtcBrowserRuntimeOptions,
} from './browser-workspace-runtime.js';
import { createPtcLabBrowserTextEvidencePolicy } from '../../lab/browser/core/lab-browser-policy.js';
import { runPtcLabBrowserTextEvidence } from '../../lab/browser/text-evidence/lab-browser-text-evidence.js';
import { browserTextEvidenceFailure } from '../../lab/browser/text-evidence/lab-browser-text-evidence-contract.js';
import { definedPtcProps } from '../../shared/record-shape.js';

export function createPtcBrowserTextEvidenceRuntime(
  options: PtcBrowserRuntimeOptions = {},
): PtcBrowserTextEvidenceRuntime {
  const workspaceRuntimeOwner = createPtcBrowserWorkspaceRuntimeOwner({
    options,
    labPolicyId: PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID,
    createBrowserPolicy: () =>
      createPtcLabBrowserTextEvidencePolicy({
        maxNavigationMs: PTC_BROWSER_TEXT_EVIDENCE_MAX_TIMEOUT_MS,
      }),
    workspaceRuntimeUnavailable: (
      diagnostics,
    ): Extract<PtcBrowserTextEvidenceRuntimeResult, { ok: false }> =>
      browserTextEvidenceFailure(
        'ptc_lab_browser_session_unavailable',
        'PTC browser text evidence workspace runtime is unavailable',
        'session_acquisition',
        { diagnostics },
      ),
    cleanupFailureReasonCode:
      'ptc_browser_text_evidence_session_cleanup_failed',
    cleanupFailureMessage: 'PTC browser text evidence session cleanup failed',
  });

  return {
    async collectEvidence(args) {
      const workspaceRuntime = await admitPtcBrowserWorkspaceRuntime({
        owner: workspaceRuntimeOwner,
        runContext: args.runContext,
        trustContextId:
          options.trustContextId ?? PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID,
        admissionFailed: (admission) =>
          browserTextEvidenceFailure(
            'ptc_lab_browser_policy_disabled',
            admission.message,
            'policy_admission',
            {
              diagnostics: { admissionReasonCode: admission.reasonCode },
            },
          ),
      });
      if (!workspaceRuntime.ok) {
        return workspaceRuntime;
      }

      return await runPtcLabBrowserTextEvidence({
        admission: workspaceRuntime.value.admission,
        identity: workspaceRuntime.value.identity,
        sessionManager: workspaceRuntime.value.sessionManager,
        request: args.request,
        ...definedPtcProps({
          commandRunner: options.commandRunner,
          dockerPath: options.dockerPath,
          now: options.now,
          signal: args.signal,
        }),
      });
    },

    async closeAll(args?: {
      signal?: AbortSignal;
    }): Promise<PtcBrowserTextEvidenceRuntimeCleanupResult> {
      return await workspaceRuntimeOwner.closeAll(args);
    },
  };
}
