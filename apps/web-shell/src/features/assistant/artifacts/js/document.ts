import { buildJsRuntimePersistenceBootstrap } from '../../runtime-persistence/artifact-runtime-persistence-bootstrap.js';
import { JS_ARTIFACT_RUNTIME_DOCUMENT_SOURCE } from './document-source.js';
import { replaceTemplateTokens } from '../../../artifacts/artifact-template-tokens.js';

export const JS_RUNTIME_ROOT_ID = 'geulbat-js-root';

export function buildJsArtifactRuntimeDocument(
  payload: string,
  persistenceBootstrap: {
    scopeHandle: string;
    parentOrigin: string;
    awaitStorageBeforePayload?: boolean;
  },
): string {
  const escapedPayload = JSON.stringify(payload).replace(/</g, '\\u003C');
  const escapedScopeHandle = JSON.stringify(
    persistenceBootstrap.scopeHandle,
  ).replace(/</g, '\\u003C');
  const escapedParentOrigin = JSON.stringify(
    persistenceBootstrap.parentOrigin,
  ).replace(/</g, '\\u003C');
  const escapedAwaitStorageBeforePayload = JSON.stringify(
    persistenceBootstrap.awaitStorageBeforePayload ?? true,
  );

  return replaceTemplateTokens(JS_ARTIFACT_RUNTIME_DOCUMENT_SOURCE, {
    __GEULBAT_JS_RUNTIME_ROOT_ID__: JS_RUNTIME_ROOT_ID,
    __GEULBAT_JS_RUNTIME_ROOT_ID_JSON__: JSON.stringify(JS_RUNTIME_ROOT_ID),
    __GEULBAT_ESCAPED_PAYLOAD__: escapedPayload,
    __GEULBAT_ESCAPED_SCOPE_HANDLE__: escapedScopeHandle,
    __GEULBAT_PARENT_ORIGIN_JSON__: escapedParentOrigin,
    __GEULBAT_AWAIT_STORAGE_BEFORE_PAYLOAD_JSON__:
      escapedAwaitStorageBeforePayload,
    __GEULBAT_PERSISTENCE_BOOTSTRAP__:
      buildJsRuntimePersistenceBootstrap(persistenceBootstrap),
  });
}
