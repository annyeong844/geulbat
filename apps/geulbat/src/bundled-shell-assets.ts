import { fileURLToPath } from 'node:url';

/**
 * 번들된 web-shell 산출물의 위치를 이 진입점 모듈 기준으로 찾는다.
 *
 * 상대 경로 하나가 두 배치를 모두 덮는다. source checkout에서는
 * `apps/geulbat/dist/` → `apps/web-shell/dist`, 설치된 패키지에서는
 * `node_modules/@geulbat/product/dist/` → `node_modules/@geulbat/web-shell/dist`
 * 로 해석된다. 두 경우 모두 형제 패키지가 같은 부모 아래 있기 때문이다.
 * 같은 규칙을 이미 `bundledCreatorPluginRoot`가 쓴다.
 *
 * 데몬은 이 위치를 모른다. shell을 어디서 가져오는지는 제품 진입점의 일이고,
 * 데몬은 넘겨받은 경로만 서빙한다 — 그래야 web-shell이 교체 가능한 클라이언트로
 * 남는다.
 */
const BUNDLED_SHELL_ASSET_RELATIVE_PATH = '../../web-shell/dist';

/** 산출물이 실제로 존재하는지 판정하는 표식. 빌드 없이는 이 파일이 없다. */
const SHELL_ENTRY_DOCUMENT_NAME = 'index.html';

export interface BundledShellAssetResolution {
  /** 서빙 가능한 산출물 루트. 없으면 `null`. */
  shellAssetRoot: string | null;
  /** 판정에 사용한 경로 — 없을 때 진단에 그대로 실어야 한다. */
  resolvedPath: string;
}

export function resolveBundledShellAssetRoot(args: {
  moduleUrl: string;
  entryDocumentExists: (path: string) => boolean;
}): BundledShellAssetResolution {
  const resolvedPath = fileURLToPath(
    new URL(BUNDLED_SHELL_ASSET_RELATIVE_PATH, args.moduleUrl),
  );
  const entryDocumentPath = fileURLToPath(
    new URL(
      `${BUNDLED_SHELL_ASSET_RELATIVE_PATH}/${SHELL_ENTRY_DOCUMENT_NAME}`,
      args.moduleUrl,
    ),
  );

  return {
    resolvedPath,
    shellAssetRoot: args.entryDocumentExists(entryDocumentPath)
      ? resolvedPath
      : null,
  };
}
