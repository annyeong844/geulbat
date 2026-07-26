import { apiFetch, isApiOkResponse } from './client.js';

export type QwenTokenPlanRegion = 'global' | 'china';
export type QwenTokenPlanStatus =
  | {
      state: 'missing';
      region: QwenTokenPlanRegion;
      baseUrl: string;
    }
  | {
      state: 'ready';
      source: 'environment' | 'stored';
      region: QwenTokenPlanRegion;
      baseUrl: string;
    };

export async function getQwenTokenPlanStatus(): Promise<QwenTokenPlanStatus> {
  return apiFetch(
    '/api/qwen-token-plan/status',
    undefined,
    isQwenTokenPlanStatus,
  );
}

export async function connectQwenTokenPlan(args: {
  apiKey: string;
  region: QwenTokenPlanRegion;
}): Promise<QwenTokenPlanStatus> {
  return apiFetch(
    '/api/qwen-token-plan/connect',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    },
    isQwenTokenPlanStatus,
  );
}

export async function disconnectQwenTokenPlan(): Promise<void> {
  await apiFetch(
    '/api/qwen-token-plan/disconnect',
    { method: 'POST' },
    isApiOkResponse,
  );
}

function isQwenTokenPlanStatus(value: unknown): value is QwenTokenPlanStatus {
  if (!isRecord(value)) {
    return false;
  }
  if (
    (value['state'] !== 'missing' && value['state'] !== 'ready') ||
    (value['region'] !== 'global' && value['region'] !== 'china') ||
    typeof value['baseUrl'] !== 'string'
  ) {
    return false;
  }
  return value['state'] === 'missing'
    ? value['source'] === undefined
    : value['source'] === 'environment' || value['source'] === 'stored';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
