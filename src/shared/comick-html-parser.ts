/**
 * Shared utility for parsing alternate titles from ComicK HTML
 * 
 * This module is designed to be bundled into both content script and viewer,
 * avoiding runtime module loading issues while preventing code duplication.
 */

/**
 * Extract alternate titles from HTML string (for parsing fetched manga info page)
 * Works with DOMParser which is available in both page and content script contexts.
 */
export function extractAlternateTitlesFromHtml(html: string): string[] {
  const titles = new Set<string>();
  
  // Create a temporary DOM parser
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // Try extracting from __NEXT_DATA__ script
  try {
    const nextDataScript = doc.getElementById('__NEXT_DATA__');
    if (nextDataScript) {
      const data = JSON.parse(nextDataScript.textContent || '{}');
      const pageProps = data?.props?.pageProps;
      
      if (pageProps) {
        // Add englishTitle if available
        if (pageProps.englishTitle && typeof pageProps.englishTitle === 'string') {
          titles.add(pageProps.englishTitle.trim());
        }
        
        // Add filteredTitles if available
        if (Array.isArray(pageProps.filteredTitles)) {
          for (const title of pageProps.filteredTitles) {
            if (typeof title === 'string' && title.trim()) {
              titles.add(title.trim());
            }
          }
        }
        
        // Add md_titles from comic object
        const comic = pageProps.comic;
        if (comic?.md_titles && Array.isArray(comic.md_titles)) {
          for (const titleObj of comic.md_titles) {
            const titleStr = typeof titleObj === 'string' ? titleObj : titleObj?.title;
            if (titleStr && typeof titleStr === 'string' && titleStr.trim()) {
              titles.add(titleStr.trim());
            }
          }
        }
      }
    }
  } catch (e) {
    // Silent fail
  }
  
  // DOM fallback: alternate titles div
  try {
    // New shadcn-style class: text-muted-foreground (Tailwind v4 migration ~2025).
    // Old text-gray-500 selector kept as fallback for cached/older HTML.
    const altTitlesDiv =
      doc.querySelector('div.overflow-auto.text-muted-foreground') ||
      doc.querySelector('div.text-gray-500.overflow-auto[style*="max-height"]');
    if (altTitlesDiv) {
      const text = altTitlesDiv.textContent?.trim() || '';
      if (text.includes(' • ')) {
        const potentialTitles = text.split(' • ').map(t => t.trim()).filter(t => t.length > 0);
        if (potentialTitles.length >= 1 && potentialTitles.every(t => t.length < 200 && !t.includes(':'))) {
          for (const title of potentialTitles) {
            titles.add(title);
          }
        }
      }
    }
  } catch (e) {
    // Silent fail
  }
  
  // Extract h2 secondary title (subtitle, not section headings).
  // New layout puts h2.text-muted-foreground inside the title block, two levels above
  // the h1 — not as a direct sibling. We widen the scope to the title block when present,
  // falling back to h1.parentElement for the old layout.
  try {
    const titleBlock = doc.querySelector('[class*="md:col-span-2"][class*="flex-col"][class*="space-y-4"]');
    const h1 = doc.querySelector('h1');
    const scope = titleBlock || (h1 ? h1.parentElement : null);
    if (scope) {
      const h2s = scope.querySelectorAll('h2');
      for (const h2 of h2s) {
        if (h2.id) continue; // Skip section headings (comments, chapter-header, recommendations)
        const h2Text = h2.textContent?.trim();
        if (h2Text && h2Text.length > 0 && h2Text.length < 200) {
          titles.add(h2Text);
          break; // Only take the first subtitle h2
        }
      }
    }
  } catch (e) {
    // Silent fail
  }
  
  // Add h1 title
  try {
    const h1 = doc.querySelector('h1');
    if (h1) {
      const h1Text = h1.textContent?.trim();
      if (h1Text && h1Text.length > 0 && !h1Text.toLowerCase().includes('comick')) {
        titles.add(h1Text);
      }
    }
  } catch (e) {
    // Silent fail
  }
  
  return Array.from(titles);
}
