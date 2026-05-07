import {
  installArtifactRuntimePersistenceBootstrap,
  type PersistenceBootstrapWindow,
} from './artifact-runtime-persistence-bootstrap-runtime.js';

type RuntimePersistenceBootstrapSeed = Window &
  Partial<PersistenceBootstrapWindow>;

function configureRuntimePersistenceWindow(
  runtimeWindow: RuntimePersistenceBootstrapSeed,
): asserts runtimeWindow is Window & PersistenceBootstrapWindow {
  runtimeWindow.__GEULBAT_PERSISTENCE_BRIDGE_VERSION__ = JSON.parse(
    '__GEULBAT_PERSISTENCE_BRIDGE_VERSION_JSON__',
  ) as string | number;
  runtimeWindow.__GEULBAT_PERSISTENCE_SCOPE_HANDLE__ = JSON.parse(
    '__GEULBAT_PERSISTENCE_SCOPE_HANDLE_JSON__',
  ) as string;
  runtimeWindow.__GEULBAT_PERSISTENCE_PARENT_ORIGIN__ = JSON.parse(
    '__GEULBAT_PERSISTENCE_PARENT_ORIGIN_JSON__',
  ) as string;
  runtimeWindow.__GEULBAT_PERSISTENCE_REQUEST_KIND__ = JSON.parse(
    '__GEULBAT_PERSISTENCE_REQUEST_KIND_JSON__',
  ) as string;
  runtimeWindow.__GEULBAT_PERSISTENCE_RESPONSE_KIND__ = JSON.parse(
    '__GEULBAT_PERSISTENCE_RESPONSE_KIND_JSON__',
  ) as string;
  runtimeWindow.__GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS__ = Number(
    '__GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS_VALUE__',
  );
}

const runtimeWindow: RuntimePersistenceBootstrapSeed = window;
configureRuntimePersistenceWindow(runtimeWindow);

installArtifactRuntimePersistenceBootstrap(runtimeWindow, {
  loadVerb: JSON.parse('__GEULBAT_PERSISTENCE_VERB_LOAD_JSON__') as string,
  saveVerb: JSON.parse('__GEULBAT_PERSISTENCE_VERB_SAVE_JSON__') as string,
  clearVerb: JSON.parse('__GEULBAT_PERSISTENCE_VERB_CLEAR_JSON__') as string,
});
