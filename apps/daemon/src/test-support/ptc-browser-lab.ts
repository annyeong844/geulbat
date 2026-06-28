import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
} from '../daemon/ptc/lab/profile/lab-profile.js';
import type { PtcLabPolicyId } from '../daemon/ptc/lab/profile/lab-profile-contract.js';
import { createPtcLabOpenEgressLocalPolicy } from '../daemon/ptc/lab/network/lab-network-policy.js';
import {
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  type PtcSessionDockerPolicy,
} from '../daemon/ptc/lab/session/session-docker-contract.js';

export type PtcBrowserTestLabNetworkMode = 'open' | 'disabled';

export interface PtcBrowserTestLab {
  admission: PtcLabAdmittedProfile;
  labPolicy: PtcLabPolicyProjection;
  dockerPolicy: PtcSessionDockerPolicy;
}

export interface CreatePtcBrowserTestLabArgs {
  policyId: PtcLabPolicyId;
  browser: PtcLabPolicyProjection['browser'];
  networkMode?: PtcBrowserTestLabNetworkMode;
  admissionErrorMessage: string;
}

export function createPtcBrowserTestLab(
  args: CreatePtcBrowserTestLabArgs,
): PtcBrowserTestLab {
  const basePolicy = createPtcLabLocalDockerPolicyProjection();
  const labPolicy: PtcLabPolicyProjection = {
    ...basePolicy,
    policyId: args.policyId,
    network:
      args.networkMode === 'disabled'
        ? basePolicy.network
        : createPtcLabOpenEgressLocalPolicy({
            metricsCoverage: 'owner_outcome_only',
          }),
    browser: args.browser,
  };
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy,
  });
  if (!admission.ok) {
    throw new Error(args.admissionErrorMessage);
  }

  return {
    admission: admission.value,
    labPolicy,
    dockerPolicy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      labPolicyId: labPolicy.policyId,
      network: labPolicy.network,
      browser: labPolicy.browser,
    },
  };
}
