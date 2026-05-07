import { ARTIFACT_RUNTIME_PERSISTENCE_BOOTSTRAP_SOURCE } from './artifact-runtime-persistence-bootstrap-source.js';
import { replaceTemplateTokens } from '../../artifacts/artifact-template-tokens.js';
import {
  ARTIFACT_RUNTIME_PERSISTENCE_VERBS,
  PERSISTENCE_BRIDGE_VERSION,
  PERSISTENCE_REQUEST_KIND,
  PERSISTENCE_RESPONSE_KIND,
} from './artifact-runtime-persistence-types.js';

export function buildJsRuntimePersistenceBootstrap(args: {
  scopeHandle: string;
  parentOrigin: string;
  requestTimeoutMs?: number;
}): string {
  const encodeJsonForEmbeddedJsString = (value: unknown) =>
    JSON.stringify(value)
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029');

  return replaceTemplateTokens(ARTIFACT_RUNTIME_PERSISTENCE_BOOTSTRAP_SOURCE, {
    __GEULBAT_PERSISTENCE_BRIDGE_VERSION_JSON__: encodeJsonForEmbeddedJsString(
      PERSISTENCE_BRIDGE_VERSION,
    ),
    __GEULBAT_PERSISTENCE_SCOPE_HANDLE_JSON__: encodeJsonForEmbeddedJsString(
      args.scopeHandle,
    ),
    __GEULBAT_PERSISTENCE_PARENT_ORIGIN_JSON__: encodeJsonForEmbeddedJsString(
      args.parentOrigin,
    ),
    __GEULBAT_PERSISTENCE_REQUEST_KIND_JSON__: encodeJsonForEmbeddedJsString(
      PERSISTENCE_REQUEST_KIND,
    ),
    __GEULBAT_PERSISTENCE_RESPONSE_KIND_JSON__: encodeJsonForEmbeddedJsString(
      PERSISTENCE_RESPONSE_KIND,
    ),
    __GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS_VALUE__: String(
      args.requestTimeoutMs ?? 5000,
    ),
    __GEULBAT_PERSISTENCE_VERB_LOAD_JSON__: encodeJsonForEmbeddedJsString(
      ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState,
    ),
    __GEULBAT_PERSISTENCE_VERB_SAVE_JSON__: encodeJsonForEmbeddedJsString(
      ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState,
    ),
    __GEULBAT_PERSISTENCE_VERB_CLEAR_JSON__: encodeJsonForEmbeddedJsString(
      ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState,
    ),
  });
}
