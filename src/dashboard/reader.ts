import type { ComickPageData, SearchResult } from '@/types';
import { sourceMappingManager } from '@/core';
import { viewer } from '@/viewer/Viewer';
import { standaloneSlug } from '@/shared/standalone';

/**
 * In-dashboard reader. The viewer runs unchanged in the extension page:
 * the bridge's direct transport, context-agnostic storage, and the shared
 * CSS bundle were all built for exactly this. The only thing standalone
 * manga need is a pre-created source mapping under their synthetic slug so
 * the viewer opens straight into chapters instead of the link-source flow.
 */

export function openReader(pageData: ComickPageData): void {
  void viewer.open(pageData);
}

/** Open a search result: ensure its mapping exists, then read. */
export async function openSearchResult(result: SearchResult, sourceId: string): Promise<void> {
  const slug = standaloneSlug(sourceId, result.slug);

  const existing = await sourceMappingManager.get(slug);
  if (!existing) {
    await sourceMappingManager.save(slug, {
      comickSlug: slug,
      comickTitle: result.title,
      selectedSource: sourceId,
      sources: {
        [sourceId]: {
          slug: result.slug,
          baseSlug: result.slug,
          title: result.title,
          available: true,
          lastChecked: Date.now(),
        },
      },
      alternateTitles: [result.title],
    });
  }

  openReader({ slug, title: result.title, pageType: 'manga' });
}
