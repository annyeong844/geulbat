import {
  PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
  PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS,
  type PtcBrowserNavigateRuntime,
  type PtcBrowserNavigateRuntimeCleanupResult,
  type PtcBrowserNavigateRuntimeResult,
} from './browser-navigate-runtime-contract.js';
import {
  admitPtcBrowserStateRuntime,
  createPtcBrowserStateRuntimeOwner,
  type PtcBrowserRuntimeOptions,
} from './browser-state-runtime.js';
import { createPtcLabBrowserUserUrlNavigationPolicy } from '../../lab/browser/core/lab-browser-policy.js';
import { runPtcLabBrowserUserUrlNavigation } from '../../lab/browser/user-url-navigation/lab-browser-user-url-navigation.js';
import { browserUserUrlNavigationFailure } from '../../lab/browser/user-url-navigation/lab-browser-user-url-navigation-contract.js';
import { definedPtcProps } from '../../shared/record-shape.js';

export function createPtcBrowserNavigateRuntime(
  options: PtcBrowserRuntimeOptions = {},
): PtcBrowserNavigateRuntime {
  const stateRuntimeOwner = createPtcBrowserStateRuntimeOwner({
    options,
    labPolicyId: PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
    createBrowserPolicy: () =>
      createPtcLabBrowserUserUrlNavigationPolicy({
        maxActionMs: PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS,
      }),
    stateRuntimeUnavailable: (
      diagnostics,
    ): Extract<PtcBrowserNavigateRuntimeResult, { ok: false }> =>
      browserUserUrlNavigationFailure(
        'ptc_lab_browser_session_unavailable',
        'PTC browser navigation state runtime is unavailable',
        'session_acquisition',
        { diagnostics },
      ),
    cleanupFailureReasonCode: 'ptc_browser_navigate_session_cleanup_failed',
    cleanupFailureMessage: 'PTC browser navigation session cleanup failed',
  });

  return {
    async navigate(args) {
      const stateRuntime = await admitPtcBrowserStateRuntime({
        owner: stateRuntimeOwner,
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
      if (!stateRuntime.ok) {
        return stateRuntime;
      }

      return await runPtcLabBrowserUserUrlNavigation({
        admission: stateRuntime.value.admission,
        identity: stateRuntime.value.identity,
        sessionManager: stateRuntime.value.sessionManager,
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
      return await stateRuntimeOwner.closeAll(args);
    },
  };
}
