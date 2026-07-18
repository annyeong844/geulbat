import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPtcPackageInstallCommand,
  buildPtcPackageInstallProvenanceCommand,
  decodePtcPackageInstallProvenanceEntries,
  derivePtcResolvedPackages,
  isSafeNpmVersionSpec,
  redactNetworkIdentifiersFromExcerpt,
  validatePtcPackageInstallRequest,
} from './execute-code-package-install.js';
import { PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX } from './execute-code-runtime-contract.js';

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
    { name: 'express', spec: 'latest' },
    { name: 'lodash', spec: 'latest' },
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
    { name: 'left-pad', spec: '^1.3.0' },
  ]);
  assert.ok(
    command.includes(
      `mkdir -p '${PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX}'`,
    ),
  );
  assert.ok(command.includes('--prefer-online'));
  assert.ok(command.includes('--ignore-scripts'));
  assert.ok(command.includes('--no-audit'));
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

void test('derivePtcResolvedPackages maps requested specs to resolved closure versions', () => {
  const resolved = derivePtcResolvedPackages({
    packages: [
      { name: 'express', spec: 'latest' },
      { name: '@scope/pkg', spec: '^1.0.0' },
      { name: 'absent', spec: 'latest' },
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
