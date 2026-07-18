import {
  isNumber,
  isString,
  tryParseJsonWithGuard,
} from '@geulbat/protocol/runtime-utils';

import {
  installArtifactRuntimePersistenceBootstrap,
  type PersistenceBootstrapWindow,
} from './artifact-runtime-persistence-bootstrap-runtime.js';

type RuntimePersistenceBootstrapSeed = Window &
  Partial<PersistenceBootstrapWindow>;

function parseInjectedBootstrapValue<T>(
  serializedValue: string,
  field: string,
  guard: (value: unknown) => value is T,
): T {
  const parsed = tryParseJsonWithGuard(serializedValue, guard);
  if (!parsed.ok) {
    throw new TypeError(
      `runtime persistence bootstrap ${field} must be valid JSON with the expected type`,
    );
  }
  return parsed.value;
}

function isPersistenceBridgeVersion(value: unknown): value is string | number {
  return isString(value) || isNumber(value);
}

function configureRuntimePersistenceWindow(
  runtimeWindow: RuntimePersistenceBootstrapSeed,
): asserts runtimeWindow is Window & PersistenceBootstrapWindow {
  runtimeWindow.__GEULBAT_PERSISTENCE_BRIDGE_VERSION__ =
    parseInjectedBootstrapValue(
      '__GEULBAT_PERSISTENCE_BRIDGE_VERSION_JSON__',
      'bridge version',
      isPersistenceBridgeVersion,
    );
  runtimeWindow.__GEULBAT_PERSISTENCE_SCOPE_HANDLE__ =
    parseInjectedBootstrapValue(
      '__GEULBAT_PERSISTENCE_SCOPE_HANDLE_JSON__',
      'scope handle',
      isString,
    );
  runtimeWindow.__GEULBAT_PERSISTENCE_PARENT_ORIGIN__ =
    parseInjectedBootstrapValue(
      '__GEULBAT_PERSISTENCE_PARENT_ORIGIN_JSON__',
      'parent origin',
      isString,
    );
  runtimeWindow.__GEULBAT_PERSISTENCE_REQUEST_KIND__ =
    parseInjectedBootstrapValue(
      '__GEULBAT_PERSISTENCE_REQUEST_KIND_JSON__',
      'request kind',
      isString,
    );
  runtimeWindow.__GEULBAT_PERSISTENCE_RESPONSE_KIND__ =
    parseInjectedBootstrapValue(
      '__GEULBAT_PERSISTENCE_RESPONSE_KIND_JSON__',
      'response kind',
      isString,
    );
  runtimeWindow.__GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS__ = Number(
    '__GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS_VALUE__',
  );
}

const runtimeWindow: RuntimePersistenceBootstrapSeed = window;
configureRuntimePersistenceWindow(runtimeWindow);

installArtifactRuntimePersistenceBootstrap(runtimeWindow, {
  loadVerb: parseInjectedBootstrapValue(
    '__GEULBAT_PERSISTENCE_VERB_LOAD_JSON__',
    'load verb',
    isString,
  ),
  saveVerb: parseInjectedBootstrapValue(
    '__GEULBAT_PERSISTENCE_VERB_SAVE_JSON__',
    'save verb',
    isString,
  ),
  clearVerb: parseInjectedBootstrapValue(
    '__GEULBAT_PERSISTENCE_VERB_CLEAR_JSON__',
    'clear verb',
    isString,
  ),
});
