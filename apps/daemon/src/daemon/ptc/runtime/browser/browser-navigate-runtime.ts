import {
  PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
  PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS,
  type PtcBrowserNavigateRuntime,
  type PtcBrowserNavigateRuntimeCleanupResult,
  type PtcBrowserNavigateRuntimeResult,
} from './browser-navigate-runtime-contract.js';
import {
  admitPtcBrowserWorkspaceRuntime,
  createPtcBrowserWorkspaceRuntimeOwner,
  type PtcBrowserRuntimeOptions,
} from './browser-workspace-runtime.js';
import { createPtcLabBrowserUserUrlNavigationPolicy } from '../../lab/browser/core/lab-browser-policy.js';
import { runPtcLabBrowserUserUrlNavigation } from '../../lab/browser/user-url-navigation/lab-browser-user-url-navigation.js';
import { browserUserUrlNavigationFailure } from '../../lab/browser/user-url-navigation/lab-browser-user-url-navigation-contract.js';
import { definedPtcProps } from '../../shared/record-shape.js';

export function createPtcBrowserNavigateRuntime(
  options: PtcBrowserRuntimeOptions = {},
): PtcBrowserNavigateRuntime {
  const workspaceRuntimeOwner = createPtcBrowserWorkspaceRuntimeOwner({
    options,
    labPolicyId: PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
    createBrowserPolicy: () =>
      createPtcLabBrowserUserUrlNavigationPolicy({
        maxActionMs: PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS,
      }),
    workspaceRuntimeUnavailable: (
      diagnostics,
    ): Extract<PtcBrowserNavigateRuntimeResult, { ok: false }> =>
      browserUserUrlNavigationFailure(
        'ptc_lab_browser_session_unavailable',
        'PTC browser navigation workspace runtime is unavailable',
        'session_acquisition',
        { diagnostics },
      ),
    cleanupFailureReasonCode: 'ptc_browser_navigate_session_cleanup_failed',
    cleanupFailureMessage: 'PTC browser navigation session cleanup failed',
  });

  return {
    async navigate(args) {
      const workspaceRuntime = await admitPtcBrowserWorkspaceRuntime({
        owner: workspaceRuntimeOwner,
        runContext: args.runContext,
        trustContextId:
          options.trustContextId ?? PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
        admissionFailed: (admission) =>
          browserUserUrlNavigationFailure(
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

      return await runPtcLabBrowserUserUrlNavigation({
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
    }): Promise<PtcBrowserNavigateRuntimeCleanupResult> {
      return await workspaceRuntimeOwner.closeAll(args);
    },
  };
}
