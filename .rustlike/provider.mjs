import { errorCodeToStatus } from '../apps/daemon/src/daemon/error-codes.ts';
import { normalizeAllowedPublicToolNames } from '../apps/daemon/src/adapter/web/ws/run-request-tools.ts';
import {
  beginConnectionAttempt,
  clearReconnectSchedule,
  createInitialRunChannelConnectionState,
  markAuthHandshakeStarted,
  markConnectionClosed,
  markConnectionReady,
  markReconnectScheduled,
} from '../apps/web-shell/src/lib/run-channel/client-state.ts';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function ok(observation) {
  return { ok: true, observation };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function buildAllowedPublicToolNamesFixture(name) {
  const base = {
    prompt: 'exec-provider',
    projectId: 'default',
  };
  switch (name) {
    case 'no_names':
      return base;
    case 'empty_names':
      return { ...base, allowedPublicToolNames: [] };
    case 'artifact_apply_default':
      return {
        ...base,
        allowedPublicToolNames: ['read_file', 'write_file', 'apply_patch'],
      };
    case 'trim_dedupe':
      return {
        ...base,
        allowedPublicToolNames: [
          ' read_file ',
          'write_file',
          'read_file',
          '  ',
          'apply_patch ',
        ],
      };
    case 'empty_after_trim':
      return { ...base, allowedPublicToolNames: ['  ', '\n', '\t'] };
    default:
      throw new Error(`unknown allowed_public_tool_names fixture: ${name}`);
  }
}

function runExactMap(contract, keys) {
  if (contract === 'http_error_mapping') {
    const values = Object.fromEntries(
      keys.map((key) => [key, errorCodeToStatus(key)]),
    );
    return ok({ kind: 'exact_map', values });
  }
  if (contract === 'allowed_public_tool_names') {
    const values = Object.fromEntries(
      keys.map((key) => [
        key,
        normalizeAllowedPublicToolNames(
          buildAllowedPublicToolNamesFixture(key),
        ) ?? null,
      ]),
    );
    return ok({ kind: 'exact_map', values });
  }
  return fail(
    'unsupported_contract',
    `provider does not implement contract '${contract}'`,
  );
}

function runTransition(contract, keys) {
  if (contract === 'run_channel_client_phase') {
    const values = Object.fromEntries(
      keys.map((key) => [key, observeRunChannelTransition(key)]),
    );
    return ok({ kind: 'transition', values });
  }
  return fail(
    'unsupported_contract',
    `provider does not implement contract '${contract}'`,
  );
}

function observeRunChannelTransition(key) {
  let state;
  switch (key) {
    case 'idle.begin_connection_attempt':
      state = createInitialRunChannelConnectionState();
      return beginConnectionAttempt(state).phase;
    case 'connecting.mark_auth_handshake_started':
      state = beginConnectionAttempt(createInitialRunChannelConnectionState());
      return markAuthHandshakeStarted(state).phase;
    case 'authenticating.mark_connection_ready':
      state = markAuthHandshakeStarted(
        beginConnectionAttempt(createInitialRunChannelConnectionState()),
      );
      return markConnectionReady(state).phase;
    case 'connected.mark_connection_closed_implicit':
      state = markConnectionReady(
        markAuthHandshakeStarted(
          beginConnectionAttempt(createInitialRunChannelConnectionState()),
        ),
      );
      return markConnectionClosed(state, false).phase;
    case 'connected.mark_connection_closed_explicit':
      state = markConnectionReady(
        markAuthHandshakeStarted(
          beginConnectionAttempt(createInitialRunChannelConnectionState()),
        ),
      );
      return markConnectionClosed(state, true).phase;
    case 'idle.mark_reconnect_scheduled':
      state = createInitialRunChannelConnectionState();
      return markReconnectScheduled(state, 99).phase;
    case 'reconnecting.clear_reconnect_schedule':
      state = markReconnectScheduled(
        createInitialRunChannelConnectionState(),
        99,
      );
      return clearReconnectSchedule(state).phase;
    case 'closed.clear_reconnect_schedule':
      state = markConnectionClosed(
        createInitialRunChannelConnectionState(),
        true,
      );
      return clearReconnectSchedule(state).phase;
    default:
      throw new Error(`unknown transition case: ${key}`);
  }
}

function handleRequest(request) {
  if (request.version !== '0.1') {
    return fail(
      'unsupported_version',
      `unsupported version '${request.version}'`,
    );
  }
  if (request.kind === 'exact_map') {
    const keys = Array.isArray(request.payload?.keys)
      ? request.payload.keys
      : [];
    return runExactMap(request.contract, keys);
  }
  if (request.kind === 'transition') {
    const keys = Array.isArray(request.payload?.keys)
      ? request.payload.keys
      : [];
    return runTransition(request.contract, keys);
  }
  return fail('unsupported_kind', `unsupported kind '${request.kind}'`);
}

const raw = await readStdin();
const requests = JSON.parse(raw || '[]');
if (!Array.isArray(requests)) {
  process.stdout.write(
    JSON.stringify([
      fail('invalid_request_shape', 'provider request must be a JSON array'),
    ]),
  );
  process.exit(0);
}
process.stdout.write(JSON.stringify(requests.map(handleRequest)));
