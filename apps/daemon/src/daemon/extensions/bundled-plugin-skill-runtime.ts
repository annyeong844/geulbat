import { existsSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';

import {
  inspectPluginPackage,
  readPluginPackageFile,
} from './plugin-package-admission.js';
import {
  buildPluginSkillCatalogEntry,
  buildPluginSkillDirectoryEntries,
  digestPluginSkillFile,
  parsePluginSkillLogicalPath,
  pluginSkillId,
  type InspectedPluginSkill,
  type PluginSkillCatalogEntry,
  type PluginSkillRuntime,
  type PluginSkillSource,
} from './plugin-skill-runtime.js';

const BUNDLED_CREATOR_INSTALLATION_ID = 'geulbat-bundled-creators';

function resolveBundledCreatorPluginRoot(
  entryPath: string | undefined,
): string {
  if (entryPath === undefined) {
    throw new Error(
      'bundled creator plugin requires a daemon entrypoint location',
    );
  }

  let directory = dirname(resolve(entryPath));
  while (true) {
    const candidate = join(directory, 'creator-plugin');
    if (existsSync(join(candidate, '.codex-plugin', 'plugin.json'))) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        'bundled creator plugin was not found beside the daemon package',
      );
    }
    directory = parent;
  }
}

export function createBundledPluginSkillRuntime(args: {
  installed: PluginSkillRuntime;
  packageRoot?: string;
}): PluginSkillRuntime {
  const packageRoot =
    args.packageRoot ?? resolveBundledCreatorPluginRoot(process.argv[1]);

  async function inspectBundle(): Promise<{
    contentDigest: string;
    skills: InspectedPluginSkill[];
    sourcePlugin: PluginSkillSource;
  }> {
    const inspected = await inspectPluginPackage(packageRoot);
    return {
      contentDigest: inspected.contentDigest,
      skills: inspected.skills,
      sourcePlugin: {
        installationId: BUNDLED_CREATOR_INSTALLATION_ID,
        name: inspected.manifest.name,
        displayName: inspected.manifest.displayName,
        version: inspected.manifest.version,
        contentDigest: inspected.contentDigest,
      },
    };
  }

  async function resolveBundledTarget(logicalPath: string): Promise<{
    entry: PluginSkillCatalogEntry;
    relativePath: string;
    skill: InspectedPluginSkill;
    bundleDigest: string;
  } | null> {
    const parsed = parsePluginSkillLogicalPath(logicalPath);
    if (parsed?.installationId !== BUNDLED_CREATOR_INSTALLATION_ID) {
      return null;
    }
    const bundle = await inspectBundle();
    const skill = bundle.skills.find(
      (candidate) => pluginSkillId(candidate.entryPath) === parsed.skillId,
    );
    if (skill === undefined) {
      throw new Error('bundled creator skill was not found');
    }
    return {
      entry: buildPluginSkillCatalogEntry({
        sourcePlugin: bundle.sourcePlugin,
        skill,
        enabled: true,
      }),
      relativePath: parsed.relativePath,
      skill,
      bundleDigest: bundle.contentDigest,
    };
  }

  async function assertBundleUnchanged(args: {
    bundleDigest: string;
    skill: InspectedPluginSkill;
  }): Promise<void> {
    const after = await inspectBundle();
    const afterSkill = after.skills.find(
      (candidate) =>
        pluginSkillId(candidate.entryPath) ===
        pluginSkillId(args.skill.entryPath),
    );
    if (
      after.contentDigest !== args.bundleDigest ||
      afterSkill?.documentDigest !== args.skill.documentDigest
    ) {
      throw new Error('bundled creator skill changed while it was being read');
    }
  }

  return {
    async listPluginSkills(options) {
      const [installed, bundle] = await Promise.all([
        args.installed.listPluginSkills(options),
        inspectBundle(),
      ]);
      const bundledSkills = bundle.skills.map((skill) =>
        buildPluginSkillCatalogEntry({
          sourcePlugin: bundle.sourcePlugin,
          skill,
          enabled: true,
        }),
      );
      return {
        skills: [...installed.skills, ...bundledSkills].sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.sourcePlugin.name.localeCompare(right.sourcePlugin.name) ||
            left.skillRef.localeCompare(right.skillRef),
        ),
        diagnostics: installed.diagnostics,
      };
    },

    async readEnabledSkillFile(logicalPath) {
      const target = await resolveBundledTarget(logicalPath);
      if (target === null) {
        return args.installed.readEnabledSkillFile(logicalPath);
      }
      if (target.relativePath === '') {
        throw new Error('bundled creator skill reference names a directory');
      }
      const packageRelativePath =
        target.relativePath === 'SKILL.md'
          ? target.skill.entryPath
          : posix.join(target.skill.directoryPath, target.relativePath);
      if (
        packageRelativePath !== target.skill.entryPath &&
        !target.skill.resourcePaths.includes(packageRelativePath)
      ) {
        throw new Error('bundled creator skill resource was not found');
      }
      const content = await readPluginPackageFile({
        packageRoot,
        relativePath: packageRelativePath,
      });
      await assertBundleUnchanged(target);
      return {
        logicalPath,
        content: new TextDecoder('utf-8', { fatal: true }).decode(content),
        contentDigest: digestPluginSkillFile(content),
        skill: target.entry,
        packageRelativePath,
      };
    },

    async listEnabledSkillDirectory(logicalPath, recursive) {
      const target = await resolveBundledTarget(logicalPath);
      if (target === null) {
        return args.installed.listEnabledSkillDirectory(logicalPath, recursive);
      }
      const files = [
        'SKILL.md',
        ...target.skill.resourcePaths.map((resourcePath) =>
          posix.relative(target.skill.directoryPath, resourcePath),
        ),
      ];
      const entries = buildPluginSkillDirectoryEntries({
        skillRootRef: target.entry.skillRootRef,
        directoryPath: target.relativePath,
        files,
        recursive,
      });
      if (entries === null) {
        throw new Error('bundled creator skill directory was not found');
      }
      await assertBundleUnchanged(target);
      return {
        logicalPath,
        entries,
        skill: target.entry,
      };
    },
  };
}
