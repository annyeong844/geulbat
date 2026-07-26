import {
  ImageGenerationError,
  type ImageGenerationProviderId,
} from './contract.js';

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
