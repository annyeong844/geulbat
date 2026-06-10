import {
  REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
  REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
  REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION,
  type HttpMetadataProbeResult,
} from '../network/http-metadata-probe.js';

export type ReactBundleDependencyProbeIdentity = {
  kind: 'esm_import' | 'stylesheet';
  specifier?: string;
  packageName?: string;
  version?: string;
  requestedUrl: string;
};

export type ReactBundleDependencyProbeResult =
  ReactBundleDependencyProbeIdentity & HttpMetadataProbeResult;

export interface ReactBundleDependencyNetworkProbeCandidate {
  schemaVersion: 1;
  adapterKind: 'react_bundle_dependency_metadata_probe';
  inputHash: string;
  probeMode: 'metadata';
  networkPolicy: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY;
  networkPolicyVersion: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION;
  allowlistId: typeof REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID;
  generatedAt: string;
  dependencyProbes: ReactBundleDependencyProbeResult[];
  failures: Array<{
    requestedUrl: string;
    reasonCode: string;
    status?: number;
  }>;
}
