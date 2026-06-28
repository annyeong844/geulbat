import { isPtcRecord } from '../../../shared/record-shape.js';

const PTC_LAB_BROWSER_FORBIDDEN_OUTPUT_KEYS = [
  'artifactcandidate',
  'body',
  'browserconsole',
  'browsercontextid',
  'bytecount',
  'console',
  'consoleoutput',
  'containerid',
  'cookie',
  'cookies',
  'download',
  'downloadpath',
  'downloads',
  'dom',
  'domtext',
  'finalurl',
  'headers',
  'host',
  'hostname',
  'hostpath',
  'html',
  'labsessionid',
  'localpath',
  'pageid',
  'profilepath',
  'query',
  'redirect',
  'redirectedfrom',
  'redirecturl',
  'request',
  'requestcount',
  'requestlog',
  'requestedurl',
  'requestedurlecho',
  'response',
  'responsebody',
  'responseheaders',
  'screenshot',
  'screenshotpath',
  'serverip',
  'status',
  'statuscode',
  'stderr',
  'stdout',
  'storage',
  'storagestate',
  'targeturl',
  'timing',
  'trace',
  'url',
  'urls',
  'userdata',
  'userdatadir',
  'video',
] as const;

const BASE_FORBIDDEN_BROWSER_OUTPUT_KEYS: ReadonlySet<string> = new Set(
  PTC_LAB_BROWSER_FORBIDDEN_OUTPUT_KEYS,
);

export const PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS = [
  'finalurldigest',
  'loadoutcome',
  'loadstate',
  'navigationdurationms',
  'redirectcount',
  'responsestatus',
  'title',
] as const;

interface PtcLabBrowserForbiddenOutputKeyOptions {
  extraForbiddenKeys?: readonly string[];
}

export interface PtcLabBrowserForbiddenOutputValueOptions {
  forbidHtmlText?: boolean;
  forbidTargetHostname?: boolean;
  forbidTargetSearchAndHash?: boolean;
  targetUrl?: string;
  value: unknown;
}

export function containsForbiddenBrowserOutputKey(
  value: unknown,
  options: PtcLabBrowserForbiddenOutputKeyOptions = {},
): boolean {
  const forbiddenKeys = buildForbiddenKeySet(options.extraForbiddenKeys);
  return containsForbiddenBrowserOutputKeyWithSet(value, forbiddenKeys);
}

export function containsForbiddenBrowserOutputValue(
  options: PtcLabBrowserForbiddenOutputValueOptions,
): boolean {
  const target = parseTargetUrl(options.targetUrl);
  return containsForbiddenBrowserOutputValueInner({
    forbidHtmlText: options.forbidHtmlText ?? false,
    forbidTargetHostname: options.forbidTargetHostname ?? false,
    forbidTargetSearchAndHash: options.forbidTargetSearchAndHash ?? false,
    target,
    value: options.value,
  });
}

export function containsForbiddenBrowserTitle(args: {
  targetUrl?: string;
  value: string;
}): boolean {
  const valueOptions: PtcLabBrowserForbiddenOutputValueOptions = {
    forbidHtmlText: true,
    forbidTargetSearchAndHash: true,
    value: args.value,
  };
  if (args.targetUrl !== undefined) {
    valueOptions.targetUrl = args.targetUrl;
  }
  return (
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(args.value) ||
    containsForbiddenBrowserOutputValue(valueOptions)
  );
}

function buildForbiddenKeySet(
  extraForbiddenKeys: readonly string[] | undefined,
): ReadonlySet<string> {
  if (extraForbiddenKeys === undefined || extraForbiddenKeys.length === 0) {
    return BASE_FORBIDDEN_BROWSER_OUTPUT_KEYS;
  }
  const keys = new Set<string>(BASE_FORBIDDEN_BROWSER_OUTPUT_KEYS);
  for (const key of extraForbiddenKeys) {
    keys.add(key.toLowerCase());
  }
  return keys;
}

function containsForbiddenBrowserOutputKeyWithSet(
  value: unknown,
  forbiddenKeys: ReadonlySet<string>,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsForbiddenBrowserOutputKeyWithSet(item, forbiddenKeys),
    );
  }
  if (!isPtcRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) =>
      forbiddenKeys.has(key.toLowerCase()) ||
      containsForbiddenBrowserOutputKeyWithSet(child, forbiddenKeys),
  );
}

function containsForbiddenBrowserOutputValueInner(args: {
  forbidHtmlText: boolean;
  forbidTargetHostname: boolean;
  forbidTargetSearchAndHash: boolean;
  target: URL | undefined;
  value: unknown;
}): boolean {
  const { value } = args;
  if (typeof value === 'string') {
    return stringContainsForbiddenBrowserOutputValue({ ...args, value });
  }
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsForbiddenBrowserOutputValueInner({ ...args, value: item }),
    );
  }
  if (!isPtcRecord(value)) {
    return false;
  }
  return Object.values(value).some((item) =>
    containsForbiddenBrowserOutputValueInner({ ...args, value: item }),
  );
}

function stringContainsForbiddenBrowserOutputValue(args: {
  forbidHtmlText: boolean;
  forbidTargetHostname: boolean;
  forbidTargetSearchAndHash: boolean;
  target: URL | undefined;
  value: string;
}): boolean {
  const lower = args.value.toLowerCase();
  return (
    /https?:\/\/|file:|cookie=|bearer|oauth|refresh[_-]?token|access[_-]?token|id[_-]?token|\/home\/|\.geulbat/iu.test(
      args.value,
    ) ||
    (args.forbidHtmlText && /<html|<\/html|<script/iu.test(args.value)) ||
    (args.forbidTargetHostname &&
      args.target !== undefined &&
      lower.includes(args.target.hostname.toLowerCase())) ||
    (args.forbidTargetSearchAndHash &&
      args.target !== undefined &&
      ((args.target.search.length > 0 &&
        lower.includes(args.target.search.toLowerCase())) ||
        (args.target.hash.length > 0 &&
          lower.includes(args.target.hash.toLowerCase()))))
  );
}

function parseTargetUrl(value: string | undefined): URL | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
