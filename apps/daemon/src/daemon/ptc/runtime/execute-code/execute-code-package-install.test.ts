import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPtcPackageInstallCommand,
  buildPtcPackageInstallProvenanceCommand,
  decodePtcPackageInstallProvenanceEntries,
  derivePtcResolvedPackages,
  isSafeNpmVersionSpec,
  isSafePythonPackageName,
  isSafePythonVersionSpec,
  redactNetworkIdentifiersFromExcerpt,
  resolvePtcPackageInstallManager,
  validatePtcPackageInstallRequest,
} from './execute-code-package-install.js';
import {
  PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX,
  PTC_EXECUTE_CODE_INSTALLED_PYTHON_PACKAGES_PATH,
} from './execute-code-runtime-contract.js';

void test('package install validation admits exact packages and sorts them', () => {
  const result = validatePtcPackageInstallRequest({
    request: {
      packages: [
        { name: 'zod', version: '3.23.8' },
        { name: '@scope/pkg', version: '1.0.0' },
      ],
    },
    maxPackages: 8,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(
    result.value.map((pkg) => pkg.name),
    ['@scope/pkg', 'zod'],
  );
});

void test('package install validation resolves omitted or empty versions to latest', () => {
  const result = validatePtcPackageInstallRequest({
    request: {
      packages: [{ name: 'express' }, { name: 'lodash', version: '' }],
    },
    maxPackages: 8,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.value, [
    { name: 'express', spec: 'latest', requestedSpec: 'latest' },
    { name: 'lodash', spec: 'latest', requestedSpec: 'latest' },
  ]);
});

void test('package install validation admits ranges and dist-tags (slice 2 resolver grammar)', () => {
  const specs = [
    '^1.3.0',
    '~1.2.0',
    '1.x',
    '>=1.0.0 <2.0.0',
    '^1 || ^2',
    'next',
    'beta',
  ];
  for (const version of specs) {
    const result = validatePtcPackageInstallRequest({
      request: { packages: [{ name: 'left-pad', version }] },
      maxPackages: 8,
    });
    assert.equal(result.ok, true, `expected ${version} to be admitted`);
    if (result.ok) {
      assert.equal(result.value[0]?.spec, version);
    }
  }
});

void test('package install validation rejects unsafe names and non-registry / shell-unsafe version specs', () => {
  const invalidRequests = [
    [],
    [{ name: 'git:evil', version: '1.0.0' }],
    [{ name: 'https://evil.example/pkg', version: '1.0.0' }],
    [{ name: '../escape', version: '1.0.0' }],
    [{ name: 'a$(touch /pwn)', version: '1.0.0' }],
    // Non-registry / source specifiers must stay rejected even in the version.
    [{ name: 'left-pad', version: 'file:../evil' }],
    [{ name: 'left-pad', version: 'git+https://evil.example/x.git' }],
    [{ name: 'left-pad', version: 'github:owner/repo' }],
    [{ name: 'left-pad', version: 'workspace:*' }],
    [{ name: 'left-pad', version: './local' }],
    // Shell-unsafe version material must stay rejected.
    [{ name: 'left-pad', version: "1.0.0' ; rm -rf /" }],
    [{ name: 'left-pad', version: '1.0.0`id`' }],
    [{ name: 'left-pad', version: '1.0.0$(id)' }],
    // Duplicate names.
    [
      { name: 'left-pad', version: '1.3.0' },
      { name: 'left-pad', version: '^1.0.0' },
    ],
  ];
  for (const packages of invalidRequests) {
    const result = validatePtcPackageInstallRequest({
      request: { packages },
      maxPackages: 8,
    });
    assert.equal(
      result.ok,
      false,
      `expected rejection for ${JSON.stringify(packages)}`,
    );
    if (result.ok) {
      return;
    }
    assert.equal(result.reasonCode, 'ptc_package_install_request_invalid');
  }
});

void test('isSafeNpmVersionSpec blocks separators and quotes but allows range grammar', () => {
  for (const ok of [
    '1.3.0',
    '^1.3.0',
    '1.x',
    '*',
    'latest',
    '>=1 <2',
    '^1 || ^2',
  ]) {
    assert.equal(isSafeNpmVersionSpec(ok), true, `expected ${ok} allowed`);
  }
  for (const bad of [
    'file:x',
    'a/b',
    "1'",
    '1`',
    '1$',
    '1;2',
    '',
    ' '.repeat(0),
  ]) {
    assert.equal(isSafeNpmVersionSpec(bad), false, `expected ${bad} rejected`);
  }
  assert.equal(isSafeNpmVersionSpec('1'.repeat(257)), false);
});

void test('python package validation admits wheel registry requirements and normalizes versions', () => {
  const result = validatePtcPackageInstallRequest({
    request: {
      language: 'python',
      packages: [
        { name: 'urllib3', version: '>=2.2,<3' },
        { name: 'Requests', version: '2.32.3' },
        { name: 'idna' },
      ],
    },
    maxPackages: 8,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.value, [
    { name: 'idna', spec: '', requestedSpec: 'latest' },
    { name: 'Requests', spec: '==2.32.3', requestedSpec: '==2.32.3' },
    { name: 'urllib3', spec: '>=2.2,<3', requestedSpec: '>=2.2,<3' },
  ]);
  assert.equal(resolvePtcPackageInstallManager('python'), 'pip');
  assert.equal(resolvePtcPackageInstallManager('javascript'), 'npm');
  assert.equal(resolvePtcPackageInstallManager(undefined), 'npm');
});

void test('python package validation rejects direct references, extras, and normalized duplicates', () => {
  const invalidRequests = [
    [{ name: 'https://evil.example/pkg.whl', version: '1.0.0' }],
    [{ name: '../escape', version: '1.0.0' }],
    [{ name: 'requests[security]', version: '2.32.3' }],
    [{ name: 'requests', version: 'https://evil.example/pkg.whl' }],
    [{ name: 'requests', version: 'git+https://evil.example/repo.git' }],
    [{ name: 'requests', version: '2.32.3 ; python_version > "3"' }],
    [
      { name: 'my.pkg', version: '1.0.0' },
      { name: 'MY-pkg', version: '1.0.0' },
    ],
  ];
  for (const packages of invalidRequests) {
    const result = validatePtcPackageInstallRequest({
      request: { language: 'python', packages },
      maxPackages: 8,
    });
    assert.equal(
      result.ok,
      false,
      `expected rejection for ${JSON.stringify(packages)}`,
    );
  }
});

void test('python package validators keep the first slice registry-only', () => {
  for (const name of ['requests', 'typing-extensions', 'zope.interface']) {
    assert.equal(isSafePythonPackageName(name), true, name);
  }
  for (const name of ['requests[security]', 'owner/pkg', '.hidden', 'a..b']) {
    assert.equal(isSafePythonPackageName(name), false, name);
  }
  for (const spec of [
    '2.32.3',
    '==2.32.3',
    '>=2.31,<3',
    '~=2.32.0',
    '!=2.32.1',
  ]) {
    assert.equal(isSafePythonVersionSpec(spec), true, spec);
  }
  for (const spec of [
    '',
    'latest',
    '^2',
    '>=2.31, <3',
    'https://example.test/pkg.whl',
    '2.32.3;python_version>"3"',
  ]) {
    assert.equal(isSafePythonVersionSpec(spec), false, spec);
  }
});

void test('package install validation enforces the knob-provided package count limit', () => {
  const packages = Array.from({ length: 3 }, (_, index) => ({
    name: `pkg-${index}`,
    version: '1.0.0',
  }));
  assert.equal(
    validatePtcPackageInstallRequest({ request: { packages }, maxPackages: 2 })
      .ok,
    false,
  );
  assert.equal(
    validatePtcPackageInstallRequest({ request: { packages }, maxPackages: 3 })
      .ok,
    true,
  );
});

void test('package install command targets the cumulative prefix with hardened npm flags', () => {
  const command = buildPtcPackageInstallCommand([
    { name: 'left-pad', spec: '^1.3.0', requestedSpec: '^1.3.0' },
  ]);
  assert.ok(
    command.includes(
      `mkdir -p '${PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX}'`,
    ),
  );
  assert.ok(command.includes('--prefer-online'));
  assert.ok(command.includes('--ignore-scripts'));
  assert.ok(command.includes('--no-audit'));
  assert.ok(command.includes('--no-update-notifier'));
  assert.ok(command.includes("--cache '/geulbat/package-cache/npm'"));
  assert.ok(
    command.includes(
      `--prefix '${PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX}'`,
    ),
  );
  assert.ok(command.includes("'left-pad@^1.3.0'"));
  assert.ok(command.includes('--userconfig'));
  assert.ok(command.includes('--globalconfig'));
});

void test('python package install command is wheel-only and targets the reusable session path', () => {
  const command = buildPtcPackageInstallCommand(
    [
      {
        name: 'requests',
        spec: '==2.32.3',
        requestedSpec: '==2.32.3',
      },
    ],
    'pip',
  );
  assert.ok(command.includes('python3 -m pip --isolated install'));
  assert.ok(command.includes("--only-binary ':all:'"));
  assert.ok(command.includes("--cache-dir '/geulbat/package-cache/pip'"));
  assert.ok(
    command.includes(
      `--target '${PTC_EXECUTE_CODE_INSTALLED_PYTHON_PACKAGES_PATH}'`,
    ),
  );
  assert.ok(command.includes("'requests==2.32.3'"));
  assert.doesNotMatch(command, /\bnpm\b/u);
});

void test('derivePtcResolvedPackages maps requested specs to resolved closure versions', () => {
  const resolved = derivePtcResolvedPackages({
    packages: [
      { name: 'express', spec: 'latest', requestedSpec: 'latest' },
      { name: '@scope/pkg', spec: '^1.0.0', requestedSpec: '^1.0.0' },
      { name: 'absent', spec: 'latest', requestedSpec: 'latest' },
    ],
    closure: [
      {
        path: 'node_modules/express',
        name: 'express',
        version: '4.21.2',
        integrity: 'sha512-express',
        role: 'prod',
      },
      {
        path: 'node_modules/@scope/pkg',
        name: '@scope/pkg',
        version: '1.4.0',
        integrity: 'sha512-scope',
        role: 'prod',
      },
      // A transitive dependency must not be mistaken for a top-level resolution.
      {
        path: 'node_modules/express/node_modules/absent',
        name: 'absent',
        version: '9.9.9',
        role: 'prod',
      },
    ],
  });
  assert.deepEqual(resolved, [
    {
      name: 'express',
      requestedSpec: 'latest',
      resolvedVersion: '4.21.2',
      integrity: 'sha512-express',
    },
    {
      name: '@scope/pkg',
      requestedSpec: '^1.0.0',
      resolvedVersion: '1.4.0',
      integrity: 'sha512-scope',
    },
    {
      name: 'absent',
      requestedSpec: 'latest',
      resolvedVersion: null,
      integrity: null,
    },
  ]);
});

void test('python provenance decoder and resolver use normalized distribution names', () => {
  const report = {
    version: '1',
    pip_version: '26.0',
    installed: [
      {
        metadata: {
          metadata_version: '2.4',
          name: 'Typing_Extensions',
          version: '4.15.0',
        },
        metadata_location: '/tmp/geulbat-python-packages',
        installer: 'pip',
        requested: true,
      },
      {
        metadata: {
          metadata_version: '2.4',
          name: 'zipp',
          version: '3.23.0',
        },
        metadata_location: '/tmp/geulbat-python-packages',
        installer: 'pip',
        requested: false,
      },
    ],
  };
  const closure = decodePtcPackageInstallProvenanceEntries(report, 'pip');
  assert.deepEqual(closure, [
    {
      path: 'python/typing-extensions',
      name: 'Typing_Extensions',
      version: '4.15.0',
      role: 'prod',
    },
    {
      path: 'python/zipp',
      name: 'zipp',
      version: '3.23.0',
      role: 'prod',
    },
  ]);
  assert.deepEqual(
    derivePtcResolvedPackages({
      manager: 'pip',
      packages: [
        {
          name: 'typing-extensions',
          spec: '>=4.12',
          requestedSpec: '>=4.12',
        },
      ],
      closure: closure ?? [],
    }),
    [
      {
        name: 'typing-extensions',
        requestedSpec: '>=4.12',
        resolvedVersion: '4.15.0',
        integrity: null,
      },
    ],
  );
});

void test('package install provenance decoder rejects malformed closure entries', () => {
  const valid = [
    {
      path: 'node_modules/fixture',
      name: 'fixture',
      version: '1.0.0',
      resolved: 'https://registry.example/fixture.tgz',
      integrity: 'sha512-fixture',
      role: 'prod',
    },
  ];
  assert.deepEqual(decodePtcPackageInstallProvenanceEntries(valid), valid);

  const malformed: Array<{ label: string; value: unknown }> = [
    { label: 'non-array', value: {} },
    { label: 'non-record entry', value: [null] },
    {
      label: 'missing required name',
      value: [{ path: 'node_modules/fixture', role: 'prod' }],
    },
    {
      label: 'invalid optional version',
      value: [
        {
          path: 'node_modules/fixture',
          name: 'fixture',
          version: 1,
          role: 'prod',
        },
      ],
    },
    {
      label: 'invalid role',
      value: [
        {
          path: 'node_modules/fixture',
          name: 'fixture',
          role: 'peer',
        },
      ],
    },
  ];
  for (const candidate of malformed) {
    assert.equal(
      decodePtcPackageInstallProvenanceEntries(candidate.value),
      undefined,
      candidate.label,
    );
  }
});

void test('provenance command reads the prefix lockfile with a daemon-authored script', () => {
  const command = buildPtcPackageInstallProvenanceCommand();
  assert.ok(command.startsWith("node -e '"));
  assert.ok(
    command.includes(
      `${PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX}/package-lock.json`,
    ),
  );
  assert.ok(command.includes('node_modules/'));
});

void test('python provenance command uses pip inspect against the installed target', () => {
  const command = buildPtcPackageInstallProvenanceCommand('pip');
  assert.equal(
    command,
    `python3 -m pip --isolated inspect --path '${PTC_EXECUTE_CODE_INSTALLED_PYTHON_PACKAGES_PATH}'`,
  );
});

void test('network redaction removes registry urls and bare hostnames from excerpts', () => {
  const redacted = redactNetworkIdentifiersFromExcerpt(
    'fetched https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz ok\n' +
      'npm error getaddrinfo ENOTFOUND registry.npmjs.org\n' +
      'npm error request to registry.yarnpkg.com failed\n' +
      'plain line',
  );
  // No registry host leaks in either URL or bare form.
  assert.doesNotMatch(redacted, /registry\.npmjs\.org/u);
  assert.doesNotMatch(redacted, /registry\.yarnpkg\.com/u);
  assert.match(redacted, /\[redacted-url\]/u);
  assert.match(redacted, /\[redacted-host\]/u);
  assert.match(redacted, /plain line/u);
});

void test('network redaction preserves versions and single-dot package names', () => {
  const redacted = redactNetworkIdentifiersFromExcerpt(
    'added lodash.merge@1.3.0 and is-number 7.0.0 (2 packages)',
  );
  // Versions and single-dot package names are not hostnames and must survive.
  assert.match(redacted, /lodash\.merge/u);
  assert.match(redacted, /1\.3\.0/u);
  assert.match(redacted, /7\.0\.0/u);
  assert.doesNotMatch(redacted, /\[redacted-host\]/u);
});
