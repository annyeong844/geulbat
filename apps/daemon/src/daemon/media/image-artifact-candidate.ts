import { sha256Digest } from '@geulbat/content-identity/sha256';
import {
  IMAGE_ARTIFACT_PAYLOAD_SCHEMA_VERSION,
  type ImageArtifactPayloadV1,
} from '@geulbat/protocol/artifacts';
import type { DaemonArtifactCandidate } from '../artifact-candidate.js';
import type { GeneratedImageCandidate } from './contract.js';

// 검증된 생성 후보를 `image` 렌더러 아티팩트 후보로 변환한다.
// payload는 protocol이 소유한 이미지 매니페스트(JSON)이며, digest/provenance가
// 없는 후보는 이 함수에 도달할 수 없다(계약 검증이 선행된다).
//
// 바이트는 인라인하지 않는다(D-V7) — media 파일 스토어에 쓴 뒤 mediaRef만
// 매니페스트에 담아 스냅샷/와이어에서 base64가 사라진다(동영상과 동일 규범).
export function buildImageArtifactCandidate(args: {
  candidate: GeneratedImageCandidate;
  mediaRef: string;
}): DaemonArtifactCandidate {
  const { asset, provenance } = args.candidate;
  const manifest: ImageArtifactPayloadV1 = {
    schemaVersion: IMAGE_ARTIFACT_PAYLOAD_SCHEMA_VERSION,
    kind: 'generated_image',
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    digest: asset.digest,
    source: { type: 'thread_media', mediaRef: args.mediaRef },
    provenance: {
      providerId: provenance.providerId,
      model: provenance.model,
      capability: provenance.capability,
      prompt: provenance.prompt,
      ...(provenance.revisedPrompt !== undefined
        ? { revisedPrompt: provenance.revisedPrompt }
        : {}),
      generatedAt: provenance.generatedAt,
    },
  };
  const payload = JSON.stringify(manifest);
  return {
    renderer: 'image',
    payload,
    digest: sha256Digest(payload),
  };
}
