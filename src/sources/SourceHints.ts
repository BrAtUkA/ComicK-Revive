/**
 * Source-specific hints and quirks system
 * 
 * This provides a centralized registry of informational messages
 * to show users about source-specific behaviors or limitations.
 */

import { hasSpecialChars } from '@/utils/fuzzy-match';

/**
 * A hint/tip/warning to display for a specific source
 */
export interface SourceHint {
  /** Type of hint affects styling: info (neutral), warning (caution), tip (helpful) */
  type: 'info' | 'warning' | 'tip';
  
  /** The message to display to the user */
  message: string;
  
  /** 
   * Optional condition function - hint only shows when this returns true
   * @param query The current search query
   * @returns true to show the hint, false to hide it
   */
  condition?: (query: string) => boolean;
}

/**
 * Registry of source-specific hints
 * Key is the source ID (e.g., 'asura', 'mangadex')
 */
export const SOURCE_HINTS: Record<string, SourceHint[]> = {
  asura: [
    {
      type: 'info',
      message: "Special characters detected — Will search for variants automatically. (can cause rate limiting)",
      condition: (query) => hasSpecialChars(query),
    },
  ],
  mangakatana: [
    {
      type: 'info',
      message: "MangaKatana uses Cloudflare — if search fails, try again after a moment.",
    },
  ],
};

/**
 * Get applicable hints for a source given the current query
 * Returns only hints whose conditions are met (or have no condition)
 * 
 * @param sourceId The source ID to get hints for
 * @param query The current search query
 * @returns Array of applicable hints
 */
export function getApplicableHints(sourceId: string, query: string): SourceHint[] {
  const hints = SOURCE_HINTS[sourceId] || [];
  return hints.filter(hint => !hint.condition || hint.condition(query));
}

/**
 * Get the first applicable hint for a source
 * Useful when you only want to show one hint at a time
 * 
 * @param sourceId The source ID to get hints for  
 * @param query The current search query
 * @returns The first applicable hint, or null if none
 */
export function getFirstApplicableHint(sourceId: string, query: string): SourceHint | null {
  const hints = getApplicableHints(sourceId, query);
  return hints.length > 0 ? hints[0] : null;
}
