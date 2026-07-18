import type {
  PluginMarketplaceEntryView,
  PluginMarketplaceListResponse,
} from '@geulbat/protocol/plugins';

const LEAD_CATEGORY = 'Productivity';

type MarketplaceSourceRole =
  PluginMarketplaceListResponse['sources'][number]['sourceRole'];

export function filterVisibleMarketplaceEntries(args: {
  entries: readonly PluginMarketplaceEntryView[];
  sourceRoles: ReadonlyMap<string, MarketplaceSourceRole>;
  sourceFilter: 'official' | 'custom';
  capabilityFilter: 'all' | 'skills';
  normalizedQuery: string;
}): PluginMarketplaceEntryView[] {
  return args.entries.filter((entry) => {
    if (args.sourceRoles.get(entry.marketplaceId) !== args.sourceFilter) {
      return false;
    }
    if (
      args.capabilityFilter === 'skills' &&
      !entry.capabilities.some(
        (capability) =>
          capability.kind === 'skills' && capability.itemCount > 0,
      )
    ) {
      return false;
    }
    if (!args.normalizedQuery) {
      return true;
    }
    return [
      entry.displayName,
      entry.name,
      entry.description,
      entry.category,
    ].some((value) => value.toLocaleLowerCase().includes(args.normalizedQuery));
  });
}

export function selectFeaturedMarketplaceEntries(
  entries: PluginMarketplaceEntryView[],
): PluginMarketplaceEntryView[] {
  const representatives = new Map<string, PluginMarketplaceEntryView>();
  for (const entry of entries) {
    if (runtimeReadyCapabilityScore(entry) === null) {
      continue;
    }
    const current = representatives.get(entry.category);
    if (!current || compareFeaturedEntries(entry, current) < 0) {
      representatives.set(entry.category, entry);
    }
  }
  return [...representatives.values()].sort(compareFeaturedEntries);
}

function compareFeaturedEntries(
  left: PluginMarketplaceEntryView,
  right: PluginMarketplaceEntryView,
): number {
  const leftScore = runtimeReadyCapabilityScore(left);
  const rightScore = runtimeReadyCapabilityScore(right);
  if (leftScore === null) {
    return rightScore === null ? 0 : 1;
  }
  if (rightScore === null) {
    return -1;
  }
  const installedDifference =
    Number(right.installedInstallationId !== null) -
    Number(left.installedInstallationId !== null);
  if (installedDifference !== 0) {
    return installedDifference;
  }
  const supportedDifference = rightScore.supported - leftScore.supported;
  if (supportedDifference !== 0) {
    return supportedDifference;
  }
  const partialDifference = rightScore.partial - leftScore.partial;
  if (partialDifference !== 0) {
    return partialDifference;
  }
  return left.displayName.localeCompare(right.displayName);
}

function runtimeReadyCapabilityScore(
  entry: PluginMarketplaceEntryView,
): { supported: number; partial: number } | null {
  if (
    entry.status !== 'installable' &&
    entry.installedInstallationId === null
  ) {
    return null;
  }
  let supported = 0;
  let partial = 0;
  for (const capability of entry.capabilities) {
    if (capability.supportStatus === 'supported') {
      supported += capability.itemCount;
    } else if (capability.supportStatus === 'partially-supported') {
      partial += capability.itemCount;
    }
  }
  return supported + partial > 0 ? { supported, partial } : null;
}

export function groupMarketplaceEntries(
  entries: PluginMarketplaceEntryView[],
): Array<[string, PluginMarketplaceEntryView[]]> {
  const grouped = new Map<string, PluginMarketplaceEntryView[]>();
  for (const entry of entries) {
    const categoryEntries = grouped.get(entry.category);
    if (categoryEntries) {
      categoryEntries.push(entry);
    } else {
      grouped.set(entry.category, [entry]);
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => {
    if (left === LEAD_CATEGORY) {
      return -1;
    }
    if (right === LEAD_CATEGORY) {
      return 1;
    }
    return 0;
  });
}
