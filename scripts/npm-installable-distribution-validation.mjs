const DAEMON_REQUIRED_FILES = [
  'dist/index.js',
  'package.json',
  'provider-auth.config.json',
];

const FORBIDDEN_FILE_EXACT = new Set([
  '.env',
  '.env.local',
  '.geulbat/dev-auth-token',
  'provider.json',
]);

const FORBIDDEN_FILE_PREFIXES = [
  '.geulbat/auth/',
  'coverage/',
  'dist-test/',
  'src/',
];

export function collectNpmPackageValidationViolations(options) {
  const manifest = options?.manifest;
  const files = new Set((options?.files ?? []).map(normalizePackagePath));
  const packageName =
    manifest && typeof manifest === 'object' ? manifest.name : null;

  return [
    ...collectRequiredFileViolations(packageName, files),
    ...collectForbiddenFileViolations(files),
    ...collectMetadataPathViolations(manifest, files),
  ];
}

function collectRequiredFileViolations(packageName, files) {
  if (packageName !== '@geulbat/daemon') {
    return [];
  }
  return DAEMON_REQUIRED_FILES.flatMap((filePath) => {
    if (files.has(filePath)) {
      return [];
    }
    return [
      {
        code: 'package_file_missing',
        message: `npm package is missing required runtime file: ${filePath}`,
        path: filePath,
      },
    ];
  });
}

function collectForbiddenFileViolations(files) {
  return [...files].flatMap((filePath) => {
    if (!isForbiddenPackagePath(filePath)) {
      return [];
    }
    return [
      {
        code: 'package_forbidden_file_present',
        message: `npm package contains forbidden source or credential material: ${filePath}`,
        path: filePath,
      },
    ];
  });
}

function collectMetadataPathViolations(manifest, files) {
  const references = collectPackageMetadataReferences(manifest);
  return references.flatMap((reference) => {
    if (files.has(reference)) {
      return [];
    }
    return [
      {
        code: 'package_metadata_path_missing',
        message: `package metadata references a missing packed file: ${reference}`,
        path: reference,
      },
    ];
  });
}

function collectPackageMetadataReferences(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [];
  }

  const references = [
    ...collectStringReference(manifest.main),
    ...collectStringReference(manifest.module),
    ...collectStringReference(manifest.types),
    ...collectBinReferences(manifest.bin),
    ...collectExportReferences(manifest.exports),
    ...collectTypesVersionsReferences(manifest.typesVersions),
  ];

  return [...new Set(references.map(normalizePackagePath))];
}

function collectBinReferences(value) {
  if (typeof value === 'string') {
    return collectStringReference(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.values(value).flatMap(collectStringReference);
}

function collectExportReferences(value) {
  if (typeof value === 'string') {
    return collectStringReference(value);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectExportReferences);
  }
  return Object.values(value).flatMap(collectExportReferences);
}

function collectTypesVersionsReferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.values(value).flatMap((mapping) => {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      return [];
    }
    return Object.values(mapping).flatMap((entry) => {
      if (!Array.isArray(entry)) {
        return collectStringReference(entry);
      }
      return entry.flatMap(collectStringReference);
    });
  });
}

function collectStringReference(value) {
  if (typeof value !== 'string') {
    return [];
  }
  const normalized = normalizePackagePath(value);
  if (
    normalized === '' ||
    normalized.includes('*') ||
    normalized.startsWith('node:')
  ) {
    return [];
  }
  return [normalized];
}

function isForbiddenPackagePath(filePath) {
  return (
    FORBIDDEN_FILE_EXACT.has(filePath) ||
    FORBIDDEN_FILE_PREFIXES.some((prefix) => filePath.startsWith(prefix)) ||
    /\.test\.[cm]?[jt]sx?$/.test(filePath)
  );
}

function normalizePackagePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '');
}
