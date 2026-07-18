const TOOL_SIGNATURE_REF_PREFIX = 'geulbat-sdk://signature/';

export function buildToolSignatureRef(toolName: string): string {
  return `${TOOL_SIGNATURE_REF_PREFIX}${encodeURIComponent(toolName)}`;
}
