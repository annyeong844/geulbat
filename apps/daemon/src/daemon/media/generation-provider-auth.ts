import { normalizeProviderErrorCode } from '../llm/provider/provider-error.js';
import {
  ImageGenerationError,
  type ImageGenerationProviderId,
} from './contract.js';

function isProviderAuthFailure(error: unknown): boolean {
  if (error instanceof ImageGenerationError) {
    return error.surface === 'provider_auth';
  }
  return normalizeProviderErrorCode(error) === 'llm_auth_failed';
}

function isProviderNotConnectedFailure(error: unknown): boolean {
  return (
    error instanceof ImageGenerationError &&
    error.reasonCode === 'provider_not_connected'
  );
}

export async function acquireGenerationProviderAuthOrFailClosed<T>(args: {
  mediaKind: 'image' | 'video';
  providerId: ImageGenerationProviderId;
  acquire: () => Promise<T>;
}): Promise<T> {
  try {
    return await args.acquire();
  } catch (error: unknown) {
    throw new ImageGenerationError({
      surface: 'provider_auth',
      reasonCode: 'provider_not_connected',
      message: `${args.mediaKind} provider ${args.providerId} is not connected or its credential is unavailable`,
      cause: error,
    });
  }
}

// 생성 결과가 커밋되기 전의 provider 호출만 감싼다. 미연결, 취소,
// 비인증 실패는 그대로 종료하고 인증 거부만 강제 refresh 후 한 번 재시도한다.
export async function generateWithProviderAuthRetry<T>(args: {
  signal?: AbortSignal;
  runAttempt: (options: { allowRefresh: boolean }) => Promise<T>;
  forceRefresh: () => Promise<void>;
}): Promise<T> {
  try {
    return await args.runAttempt({ allowRefresh: true });
  } catch (error: unknown) {
    if (
      isProviderNotConnectedFailure(error) ||
      !isProviderAuthFailure(error) ||
      args.signal?.aborted === true
    ) {
      throw error;
    }
    await args.forceRefresh();
    return await args.runAttempt({ allowRefresh: false });
  }
}
