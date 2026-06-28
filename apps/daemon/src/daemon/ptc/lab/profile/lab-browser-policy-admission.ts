import type { PtcLabBrowserPolicy } from '../browser/core/lab-browser-policy.js';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import { admitPtcLabPolicy } from '../../shared/lab-spine.js';

type PtcLabOpenBrowserNetworkPolicy = Extract<
  NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
  { mode: 'open' }
>;
type PtcLabBrowserShellPolicy = NonNullable<
  PtcLabAdmittedProfile['labPolicy']
>['shell'];

type PtcLabEnabledBrowserMode = Exclude<
  PtcLabBrowserPolicy['mode'],
  'disabled'
>;
type PtcLabEnabledBrowserPolicy = Extract<
  PtcLabBrowserPolicy,
  { enabled: true }
>;

interface PtcLabBrowserPolicyAdmissionFailure {
  ok: false;
  reasonCode:
    | 'ptc_lab_browser_admission_required'
    | 'ptc_lab_browser_policy_disabled'
    | 'ptc_lab_browser_policy_mismatch'
    | 'ptc_lab_browser_network_disabled';
  message: string;
  phase: 'policy_admission';
}

type PtcLabOpenBrowserPolicyAdmission<
  BrowserMode extends PtcLabEnabledBrowserMode,
> =
  | {
      ok: true;
      value: {
        policyId: string;
        browser: Extract<PtcLabBrowserPolicy, { mode: BrowserMode }>;
        network: PtcLabOpenBrowserNetworkPolicy;
        shell: PtcLabBrowserShellPolicy;
      };
    }
  | PtcLabBrowserPolicyAdmissionFailure;

export function readPtcLabOpenBrowserPolicy<
  BrowserMode extends PtcLabEnabledBrowserMode,
>(args: {
  admission: PtcLabAdmittedProfile | undefined;
  browserMode: BrowserMode;
  modeMismatchMessage: string;
  subject: string;
}): PtcLabOpenBrowserPolicyAdmission<BrowserMode> {
  const labPolicy = admitPtcLabPolicy(args.admission);
  if (!labPolicy.ok) {
    return {
      ok: false,
      reasonCode: 'ptc_lab_browser_admission_required',
      message: `PTC lab browser ${args.subject} requires an admitted lab profile`,
      phase: 'policy_admission',
    };
  }
  const browser = labPolicy.value.browser;
  if (!browser.enabled) {
    return {
      ok: false,
      reasonCode: 'ptc_lab_browser_policy_disabled',
      message: `PTC lab browser ${args.subject} policy is disabled`,
      phase: 'policy_admission',
    };
  }
  if (!isPtcLabBrowserPolicyMode(browser, args.browserMode)) {
    return {
      ok: false,
      reasonCode: 'ptc_lab_browser_policy_mismatch',
      message: args.modeMismatchMessage,
      phase: 'policy_admission',
    };
  }
  if (labPolicy.value.network.mode !== 'open') {
    return {
      ok: false,
      reasonCode: 'ptc_lab_browser_network_disabled',
      message: `PTC lab browser ${args.subject} requires admitted lab open network policy`,
      phase: 'policy_admission',
    };
  }
  if (
    browser.networkPolicyId !== labPolicy.value.network.networkPolicyId ||
    labPolicy.value.network.metricsCoverage === 'runtime_observed'
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_lab_browser_policy_mismatch',
      message: `PTC lab browser ${args.subject} policy is not compatible with admitted network policy`,
      phase: 'policy_admission',
    };
  }

  return {
    ok: true,
    value: {
      policyId: labPolicy.value.policyId,
      browser,
      network: labPolicy.value.network,
      shell: labPolicy.value.shell,
    },
  };
}

function isPtcLabBrowserPolicyMode<
  BrowserMode extends PtcLabEnabledBrowserMode,
>(
  browser: PtcLabEnabledBrowserPolicy,
  mode: BrowserMode,
): browser is Extract<PtcLabEnabledBrowserPolicy, { mode: BrowserMode }> {
  return browser.mode === mode;
}
