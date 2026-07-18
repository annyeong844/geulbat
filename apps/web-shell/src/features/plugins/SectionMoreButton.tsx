import type { PluginMarketplaceEntryView } from '@geulbat/protocol/plugins';

import { marketplacePluginIconUrl } from '../../lib/api/plugins.js';
import { PluginIcon } from './PluginIcon.js';

export function SectionMoreButton({
  sectionLabel,
  hiddenEntries,
  expanded,
  onToggle,
}: {
  sectionLabel: string;
  hiddenEntries: PluginMarketplaceEntryView[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (hiddenEntries.length === 0) {
    return null;
  }
  const namedEntries = hiddenEntries.slice(0, 2);
  const remainingCount = hiddenEntries.length - namedEntries.length;
  const collapsedLabel = `${namedEntries
    .map((entry) => entry.displayName)
    .join(', ')}${remainingCount > 0 ? ` 외 ${remainingCount}개` : ''} 더 보기`;
  return (
    <button
      type="button"
      className="extension-section-more"
      aria-label={
        expanded
          ? `${sectionLabel} 플러그인 접기`
          : `${sectionLabel}의 숨겨진 플러그인 ${hiddenEntries.length}개 더 보기`
      }
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className="extension-section-more-icons" aria-hidden="true">
        {hiddenEntries.slice(0, 3).map((entry) => (
          <PluginIcon
            key={`${entry.marketplaceId}/${entry.entryId}`}
            label={entry.displayName}
            src={
              entry.iconAvailable
                ? marketplacePluginIconUrl(entry.marketplaceId, entry.entryId)
                : null
            }
            size="small"
            defer
          />
        ))}
      </span>
      <span>{expanded ? `${sectionLabel} 접기` : collapsedLabel}</span>
      <span aria-hidden="true">⌄</span>
    </button>
  );
}
