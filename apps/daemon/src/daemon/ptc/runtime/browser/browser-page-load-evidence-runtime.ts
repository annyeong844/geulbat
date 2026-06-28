import {
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_LAB_POLICY_ID,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_TIMEOUT_MS,
  type PtcBrowserPageLoadEvidenceRuntime,
  type PtcBrowserPageLoadEvidenceRuntimeCleanupResult,
  type PtcBrowserPageLoadEvidenceRuntimeResult,
} from './browser-page-load-evidence-runtime-contract.js';
import {
  admitPtcBrowserWorkspaceRuntime,
  createPtcBrowserWorkspaceRuntimeOwner,
  type PtcBrowserRuntimeOptions,
} from './browser-workspace-runtime.js';
import { createPtcLabBrowserPageLoadEvidencePolicy } from '../../lab/browser/core/lab-browser-policy.js';
import { runPtcLabBrowserPageLoadEvidence } from '../../lab/browser/page-load-evidence/lab-browser-page-load-evidence.js';
import { browserPageLoadEvidenceFailure } from '../../lab/browser/page-load-evidence/lab-browser-page-load-evidence-contract.js';
import { definedPtcProps } from '../../shared/record-shape.js';

export function createPtcBrowserPageLoadEvidenceRuntime(
  options: PtcBrowserRuntimeOptions = {},
): PtcBrowserPageLoadEvidenceRuntime {
  const workspaceRuntimeOwner = createPtcBrowserWorkspaceRuntimeOwner({
    options,
    labPolicyId: PTC_BROWSER_PAGE_LOAD_EVIDENCE_LAB_POLICY_ID,
    createBrowserPolicy: () =>
      createPtcLabBrowserPageLoadEvidencePolicy({
        maxNavigationMs: PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_TIMEOUT_MS,
      }),
    workspaceRuntimeUnavailable: (
      diagnostics,
    ): Extract<PtcBrowserPageLoadEvidenceRuntimeResult, { ok: false }> =>
      browserPageLoadEvidenceFailure(
        'ptc_lab_browser_session_unavailable',
        'PTC browser page-load evidence workspace runtime is unavailable',
        'session_acquisition',
        { diagnostics },
      ),
    cleanupFailureReasonCode:
      'ptc_browser_page_load_evidence_session_cleanup_failed',
    cleanupFailureMessage:
      'PTC browser page-load evidence session cleanup failed',
  });

  return {
    async collectEvidence(args) {
      const workspaceRuntime = await admitPtcBrowserWorkspaceRuntime({
        owner: workspaceRuntimeOwner,
        runContext: args.runContext,
        trustContextId:
          options.trustContextId ??
          PTC_BROWSER_PAGE_LOAD_EVIDENCE_LAB_POLICY_ID,
        admissionFailed: (admission) =>
          browserPageLoadEvidenceFailure(
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

      return await runPtcLabBrowserPageLoadEvidence({
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
    }): Promise<PtcBrowserPageLoadEvidenceRuntimeCleanupResult> {
      return await workspaceRuntimeOwner.closeAll(args);
    },
  };
}
