/**
 * Explicit serial lanes for tests that share a host-level resource.
 *
 * The paths are relative to the workspace passed to the test runner. Keep
 * this list evidence-backed: process.env, process.chdir, mkdtemp, and
 * listen(0) are not serial resources when each file has its own process.
 */
const SERIAL_TEST_LANES = [
  {
    name: 'docker-runtime',
    workspace: 'daemon',
    files: [
      'dist-test/daemon/ptc/runtime/execute-code/execute-code-typescript.test.js',
      'dist-test/daemon/tools/builtin/execute-code-sdk-mounted-tree.test.js',
    ],
  },
];

/**
 * Measured long-running files that should enter the bounded parallel pool
 * first. Ordering only changes when a file starts; it never changes isolation,
 * assertions, or lane ownership.
 */
const PRIORITY_TEST_FILES = [
  {
    workspace: 'daemon',
    files: [
      'dist-test/daemon/ptc/lab/browser/core/lab-browser-runtime-script-policy-events.test.js',
      'dist-test/bootstrap-entry.test.js',
      'dist-test/create-daemon.test.js',
      'dist-test/http-routes-react-bundle-inline-compile.test.js',
      'dist-test/http-routes-run-inputs.test.js',
      'dist-test/http-routes-files.test.js',
      'dist-test/http-routes-public-web-fixtures.test.js',
      'dist-test/http-routes-projects.test.js',
      'dist-test/http-routes-provider-auth.test.js',
      'dist-test/daemon/context.test.js',
      'dist-test/http-routes-input-refs.test.js',
      'dist-test/daemon/tools/builtin/wait.test.js',
    ],
  },
];

export function serialTestLanesForWorkspace(workspace) {
  return SERIAL_TEST_LANES.filter((lane) => lane.workspace === workspace);
}

export function priorityTestFilesForWorkspace(workspace) {
  return (
    PRIORITY_TEST_FILES.find((entry) => entry.workspace === workspace)?.files ??
    []
  );
}
