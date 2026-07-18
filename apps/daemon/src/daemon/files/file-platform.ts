// Public file-platform facade:
// - canonical-paths: low-level canonical IO helpers
// - *-targets: intent-specific target resolvers
// - target-types: shared target contracts
export {
  openReadHandle,
  writeAtomically,
} from './file-platform-canonical-paths.js';
export { enumerateCanonicalChildren } from './file-platform-directory-children.js';
export { isPathInsideWorkspaceBoundary as isPathInsideComputerFileScope } from './normalize-path.js';
export {
  resolveSourceReadTarget,
  resolveSourceMutationTarget,
  resolveSourceDirectoryTarget,
} from './file-platform-source-targets.js';
export { resolveDerivedArtifactTarget } from './file-platform-derived-targets.js';
export { resolveRuntimeStateTarget } from './file-platform-runtime-state-target.js';
export { resolveExplicitExportTarget } from './file-platform-explicit-export-target.js';
export type {
  SourceReadTarget,
  SourceMutationTarget,
  SourceDirectoryTarget,
  DerivedArtifactTarget,
  RuntimeStateTarget,
  ExplicitExportTarget,
  EnumeratedCanonicalChild,
  DerivedArtifactOwner,
} from './file-platform-target-types.js';
