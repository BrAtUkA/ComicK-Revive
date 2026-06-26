import { ComickPageData } from '@/types';

/**
 * ComickParser - Extracts manga/chapter data from ComicK pages
 */
export class ComickParser {
  /**
   * Parse current page URL and DOM to extract manga info
   */
  static parse(): ComickPageData | null {
    const pathname = window.location.pathname;

    // Pattern: /comic/{manga-slug}/{chapter-hid}-chapter-{num}-{lang}
    // or: /comic/{manga-slug}
    const comicMatch = pathname.match(/^\/comic\/([^\/]+)(?:\/(.+))?$/);
    
    if (!comicMatch) {
      return null;
    }

    const mangaSlug = comicMatch[1];
    const chapterPart = comicMatch[2];

    // Get title from page
    const title = this.extractTitle();
    
    // Get alternate titles
    const alternateTitles = this.extractAlternateTitles();

    if (!chapterPart) {
      // Manga info page
      return {
        slug: mangaSlug,
        title: title || mangaSlug,
        alternateTitles,
        pageType: 'manga',
      };
    }

    // Chapter page - parse chapter info
    // Format: {hid}-chapter-{num}-{lang} or variations
    // NOTE: For chapter pages, we don't extract titles from the DOM because:
    // 1. The tab title includes chapter info like "Chapter 45 - MangaName"
    // 2. The h1/DOM elements show chapter-specific content, not manga title
    // 3. __NEXT_DATA__ structure is different on chapter pages
    // The content script will fetch the manga info page to get proper titles.
    
    // Extract chapter number from DOM first (most reliable - uses the selected dropdown option)
    const domChapterNumber = this.extractChapterFromDOM();
    
    // Try URL regex as fallback for hid and language
    const chapterMatch = chapterPart.match(/^([^-]+)-chapter-([0-9.]+)-?([a-z]{2})?$/i);
    
    // Use DOM chapter number if available, otherwise fall back to URL regex
    const chapterNumber = domChapterNumber ?? (chapterMatch ? parseFloat(chapterMatch[2]) : undefined);
    const chapterHid = chapterMatch ? chapterMatch[1] : chapterPart.split('-')[0];
    const language = chapterMatch ? (chapterMatch[3] || 'en') : 'en';
    
    return {
      slug: mangaSlug,
      title: mangaSlug,  // Use slug as placeholder - will be enriched by fetchMangaInfoTitles
      alternateTitles: [],  // Empty - will be filled by fetchMangaInfoTitles
      chapterHid,
      chapterNumber,
      language,
      pageType: 'chapter',
    };
  }

  /**
   * Extract manga title from page DOM
   */
  private static extractTitle(): string | null {
    // Try various selectors that ComicK might use
    const selectors = [
      'h1',                                    // Main heading
      '[data-testid="manga-title"]',           // Test ID if present
      '.manga-title',                          // Class name
      'meta[property="og:title"]',             // OpenGraph
      'title',                                 // Page title
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        let text = '';
        
        if (element instanceof HTMLMetaElement) {
          text = element.content;
        } else if (element instanceof HTMLTitleElement) {
          text = element.textContent || '';
          // Clean up page title (often has " - ComicK" suffix)
          text = text.replace(/\s*[-|]\s*ComicK.*$/i, '');
        } else {
          text = element.textContent || '';
        }

        // Clean and validate
        text = text.trim();
        if (text && text.length > 0 && !text.toLowerCase().includes('comick')) {
          return text;
        }
      }
    }

    return null;
  }

  /**
   * Extract chapter number from the DOM chapter selector dropdown
   * Parses the selected option text like "Ch 21" or "Chapter 45.5" → number
   */
  private static extractChapterFromDOM(): number | null {
    try {
      // Look for the chapter selector dropdown - it's a select with chapter options
      // The selected option contains text like "Ch 21", "Ch 142", "Chapter 45.5"
      const chapterSelect = document.querySelector('select option[selected]');
      
      if (chapterSelect) {
        const text = chapterSelect.textContent?.trim() || '';
        // Match patterns: "Ch 21", "Ch. 21", "Chapter 21", "Ch 45.5"
        const match = text.match(/(?:Ch\.?|Chapter)\s*([0-9.]+)/i);
        if (match) {
          const num = parseFloat(match[1]);
          if (!isNaN(num)) {
            console.log('[ComicK Revive] Extracted chapter from DOM:', num);
            return num;
          }
        }
      }
      
      // Fallback: try finding select with chapter options by content
      const selects = document.querySelectorAll('select');
      for (const select of selects) {
        const selectedOption = select.querySelector('option:checked') as HTMLOptionElement | null;
        if (selectedOption) {
          const text = selectedOption.textContent?.trim() || '';
          const match = text.match(/(?:Ch\.?|Chapter)\s*([0-9.]+)/i);
          if (match) {
            const num = parseFloat(match[1]);
            if (!isNaN(num)) {
              console.log('[ComicK Revive] Extracted chapter from DOM (fallback):', num);
              return num;
            }
          }
        }
      }
    } catch (e) {
      console.warn('[ComicK Revive] Could not extract chapter from DOM:', e);
    }
    
    return null;
  }

  /**
   * Extract alternate titles from ComicK page
   * Sources: __NEXT_DATA__ JSON (md_titles, filteredTitles, englishTitle) and DOM fallback
   */
  private static extractAlternateTitles(): string[] {
    const titles = new Set<string>();
    
    // Try extracting from __NEXT_DATA__ script (Next.js data)
    try {
      const nextDataScript = document.getElementById('__NEXT_DATA__');
      if (nextDataScript) {
        const data = JSON.parse(nextDataScript.textContent || '{}');
        const pageProps = data?.props?.pageProps;
        
        if (pageProps) {
          // Add englishTitle if available
          if (pageProps.englishTitle && typeof pageProps.englishTitle === 'string') {
            titles.add(pageProps.englishTitle.trim());
          }
          
          // Add filteredTitles if available (array of strings)
          if (Array.isArray(pageProps.filteredTitles)) {
            for (const title of pageProps.filteredTitles) {
              if (typeof title === 'string' && title.trim()) {
                titles.add(title.trim());
              }
            }
          }
          
          // Add md_titles from comic object if available
          const comic = pageProps.comic;
          if (comic?.md_titles && Array.isArray(comic.md_titles)) {
            for (const titleObj of comic.md_titles) {
              // md_titles can be array of strings or objects with 'title' property
              const titleStr = typeof titleObj === 'string' ? titleObj : titleObj?.title;
              if (titleStr && typeof titleStr === 'string' && titleStr.trim()) {
                titles.add(titleStr.trim());
              }
            }
          }
        }
      }
    } catch (e) {
      // Silent fail - we'll try DOM fallback
    }
    
    // DOM fallback: extract from alternate titles div (bullet-separated)
    // The alternate titles div has specific classes and contains " • " separated titles
    // Structure: <div class="text-gray-500 dark:text-gray-400 overflow-auto md:mt-3">Title1 • Title2 • ...</div>
    try {
      // Target the specific alternate titles div by its styling classes
      // This div is a direct child container with gray text styling
      // New shadcn-style class: text-muted-foreground (Tailwind v4 migration ~2025).
      // Old text-gray-500 selector kept as fallback for cached/older HTML.
      const altTitlesDiv =
        document.querySelector('main div.overflow-auto.text-muted-foreground') ||
        document.querySelector('main div.text-gray-500.overflow-auto[style*="max-height"]');
      
      if (altTitlesDiv) {
        // Get only the direct text content, not nested elements
        // The div should only contain text nodes with bullet-separated titles
        const text = altTitlesDiv.textContent?.trim() || '';
        
        if (text.includes(' • ')) {
          const potentialTitles = text.split(' • ').map(t => t.trim()).filter(t => t.length > 0);
          // Validate: should have reasonable titles (not metadata)
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
    
    // Extract h2 secondary title (slug-matching title that some manga pages have).
    // Example: h1 = "A Genius Wizard Who Breaks Boundaries", h2 = "Limit-Breaking Genius Mage".
    // New layout (Tailwind v4) puts h2.text-muted-foreground inside the title block,
    // not as a direct sibling of h1, so we widen the search scope to the title block.
    try {
      const titleBlock = document.querySelector('main [class*="md:col-span-2"][class*="flex-col"][class*="space-y-4"]');
      const h1 = document.querySelector('h1');
      const scope = titleBlock || (h1 ? h1.parentElement : null);
      if (scope) {
        const h2s = scope.querySelectorAll('h2');
        for (const h2 of h2s) {
          if (h2.id) continue; // Skip section headings
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
    
    // Also add the main h1 title to the list
    const h1Title = this.extractTitle();
    if (h1Title) {
      titles.add(h1Title);
    }
    
    return Array.from(titles);
  }

  /**
   * Check if we're on a manga info page
   */
  static isMangaPage(): boolean {
    const data = this.parse();
    return data?.pageType === 'manga';
  }

  /**
   * Check if we're on a chapter page
   */
  static isChapterPage(): boolean {
    const data = this.parse();
    return data?.pageType === 'chapter';
  }

  /**
   * Extract alternate titles from HTML string (for parsing fetched manga info page)
   * This is a static version that works on arbitrary HTML, not just current document
   */
  static extractAlternateTitlesFromHtml(html: string): string[] {
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
    // New layout (Tailwind v4) puts h2.text-muted-foreground inside the title block,
    // not as a direct sibling of h1, so we widen the search scope to the title block.
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
            break;
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

  /**
   * Wait for page to be ready (SPAs may load content dynamically)
   */
  static waitForReady(timeout: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      // If already loaded
      if (document.readyState === 'complete') {
        resolve();
        return;
      }

      const timeoutId = setTimeout(() => {
        reject(new Error('Page load timeout'));
      }, timeout);

      window.addEventListener('load', () => {
        clearTimeout(timeoutId);
        resolve();
      }, { once: true });
    });
  }

  /**
   * Observe for SPA navigation changes
   */
  static observeNavigation(callback: (data: ComickPageData | null) => void): () => void {
    let lastUrl = window.location.href;

    // Check for URL changes
    const checkUrl = () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        // Small delay for DOM to update
        setTimeout(() => {
          callback(this.parse());
        }, 100);
      }
    };

    // Use MutationObserver to detect SPA changes
    const observer = new MutationObserver(() => {
      checkUrl();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Also listen for popstate (back/forward)
    const handlePopstate = () => {
      checkUrl();
    };
    window.addEventListener('popstate', handlePopstate);

    // Return cleanup function
    return () => {
      observer.disconnect();
      window.removeEventListener('popstate', handlePopstate);
    };
  }
}
