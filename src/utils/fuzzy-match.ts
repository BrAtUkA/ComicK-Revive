/**
 * Simple fuzzy matching for manga title search
 */

/**
 * Normalize a string for comparison
 * - Lowercase
 * - Remove special characters
 * - Collapse whitespace
 */
export function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove special chars
    .replace(/\s+/g, ' ')    // Collapse whitespace
    .trim();
}

/**
 * Calculate similarity between two strings (0-1)
 * Uses a combination of techniques for manga title matching
 */
export function similarity(a: string, b: string): number {
  const normA = normalize(a);
  const normB = normalize(b);

  // Guard: normalize() strips non-ASCII, so pure CJK/Korean strings become "".
  // Empty vs anything would false-match on containment ("".includes("") === true).
  if (!normA || !normB) return 0;

  // Exact match
  if (normA === normB) return 1;

  // One contains the other
  if (normA.includes(normB) || normB.includes(normA)) {
    const longer = Math.max(normA.length, normB.length);
    const shorter = Math.min(normA.length, normB.length);
    return 0.8 + (0.2 * shorter / longer);
  }

  // Word-based matching
  const wordsA = normA.split(' ');
  const wordsB = normB.split(' ');
  
  let matchedWords = 0;
  for (const wordA of wordsA) {
    if (wordsB.some(wordB => wordB.includes(wordA) || wordA.includes(wordB))) {
      matchedWords++;
    }
  }

  const wordSimilarity = matchedWords / Math.max(wordsA.length, wordsB.length);

  // Levenshtein distance (for typos)
  const levenshteinSim = 1 - (levenshteinDistance(normA, normB) / Math.max(normA.length, normB.length));

  // Combine scores
  return Math.max(wordSimilarity * 0.7, levenshteinSim * 0.5);
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Find best matches from a list of candidates
 */
export function findBestMatches<T>(
  query: string,
  candidates: T[],
  getText: (item: T) => string,
  limit: number = 5,
  threshold: number = 0.3
): { item: T; score: number }[] {
  const scored = candidates.map(item => ({
    item,
    score: similarity(query, getText(item)),
  }));

  return scored
    .filter(x => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Find best matches using multiple reference titles.
 * Each candidate is scored against ALL queries; the highest score wins.
 */
export function findBestMatchesMultiRef<T>(
  queries: string[],
  candidates: T[],
  getText: (item: T) => string,
  limit: number = 5,
  threshold: number = 0.3
): { item: T; score: number }[] {
  if (queries.length === 0) return [];

  const scored = candidates.map(item => {
    const text = getText(item);
    let best = 0;
    for (const q of queries) {
      const s = similarity(q, text);
      if (s > best) best = s;
    }
    return { item, score: best };
  });

  return scored
    .filter(x => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Check if two titles likely refer to the same manga
 */
export function isSameManga(title1: string, title2: string, threshold: number = 0.7): boolean {
  return similarity(title1, title2) >= threshold;
}

/**
 * Normalize a title to URL slug format for comparison
 * - Lowercase
 * - Replace spaces/underscores with dashes
 * - Remove special characters except dashes
 * - Collapse multiple dashes
 */
export function normalizeToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[''`]/g, '')           // Remove apostrophes
    .replace(/[\s_]+/g, '-')          // Replace spaces/underscores with dashes
    .replace(/[^\w-]/g, '')           // Remove special chars except dashes
    .replace(/-+/g, '-')              // Collapse multiple dashes
    .replace(/^-|-$/g, '')            // Trim leading/trailing dashes
    .trim();
}

/**
 * Find the best matching title for a URL slug
 * Compares each title's normalized slug against the URL slug
 * Returns the title with highest similarity score
 */
export function findBestTitleForUrl(urlSlug: string, titles: string[]): string | null {
  if (!titles.length) return null;
  
  // Clean the URL slug (remove leading numbers like "02-")
  const cleanedUrlSlug = urlSlug.replace(/^\d+-/, '');
  
  let bestTitle = titles[0];
  let bestScore = 0;
  
  for (const title of titles) {
    const titleSlug = normalizeToSlug(title);
    
    // Calculate similarity between title slug and URL slug
    const score = similarity(titleSlug, cleanedUrlSlug);
    
    // Bonus for exact containment
    if (cleanedUrlSlug.includes(titleSlug) || titleSlug.includes(cleanedUrlSlug)) {
      const containmentBonus = Math.min(titleSlug.length, cleanedUrlSlug.length) / 
                               Math.max(titleSlug.length, cleanedUrlSlug.length) * 0.3;
      if (score + containmentBonus > bestScore) {
        bestScore = score + containmentBonus;
        bestTitle = title;
      }
    } else if (score > bestScore) {
      bestScore = score;
      bestTitle = title;
    }
  }
  
  return bestTitle;
}

// ═══════════════════════════════════════════════════════════════════════════
// QUERY VARIANT GENERATION FOR SEARCH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Character variant groups - characters that should be tried interchangeably
 * Order matters: first variant in each group is the "preferred" ASCII version
 */
const CHAR_VARIANT_GROUPS: string[][] = [
  ["'", "'", "'", "’", "`", "´", "ʻ", "ʼ"],  // Apostrophe variants (straight first)
  ['"', '"', '"', '„'],                   // Double quote variants
  ['-', '–', '—', '−'],                   // Dash variants (hyphen first)
  ['...', '…'],                           // Ellipsis
];

/**
 * Find which variant group a character belongs to
 */
function findVariantGroup(char: string): string[] | null {
  for (const group of CHAR_VARIANT_GROUPS) {
    if (group.includes(char)) {
      return group;
    }
  }
  return null;
}

/**
 * Find all special characters in a query that have variants
 * Returns array of { position, char, group }
 */
function findSpecialCharPositions(query: string): Array<{ position: number; char: string; group: string[] }> {
  const positions: Array<{ position: number; char: string; group: string[] }> = [];
  
  // Check for ellipsis first (multi-char)
  let ellipsisIndex = query.indexOf('…');
  if (ellipsisIndex !== -1) {
    positions.push({ position: ellipsisIndex, char: '…', group: ['...', '…'] });
  }
  
  // Check single characters
  for (let i = 0; i < query.length; i++) {
    const char = query[i];
    const group = findVariantGroup(char);
    if (group && char !== '…') { // Skip ellipsis, handled above
      positions.push({ position: i, char, group });
    }
  }
  
  return positions;
}

/**
 * Generate query variants by replacing special characters with their alternatives
 * 
 * Priority order:
 * 1. Original query
 * 2. All special chars replaced with straight ASCII (', ", -)
 * 3. All special chars removed
 * 4. Each variant in each group (all combinations)
 * 
 * @param query The search query
 * @returns Array of query variants to try in order (no limit)
 */
export function generateQueryVariants(query: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  
  const addVariant = (v: string) => {
    const trimmed = v.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      variants.push(trimmed);
    }
  };
  
  // 1. Original query
  addVariant(query);
  
  const positions = findSpecialCharPositions(query);
  
  if (positions.length === 0) {
    // No special characters, return just the original
    return variants;
  }
  
  // 2. All replaced with straight ASCII (first in each group)
  let asciiVersion = query;
  for (const pos of positions) {
    const asciiChar = pos.group[0]; // First in group is ASCII
    asciiVersion = asciiVersion.replace(pos.char, asciiChar);
  }
  addVariant(asciiVersion);
  
  // 3. All special chars removed
  let removedVersion = query;
  for (const pos of positions) {
    for (const variant of pos.group) {
      removedVersion = removedVersion.split(variant).join('');
    }
  }
  // Clean up double spaces
  removedVersion = removedVersion.replace(/\s+/g, ' ').trim();
  addVariant(removedVersion);
  
  // 4. Try each group variant one at a time (all positions in that group)
  // This handles cases where maybe they used a different apostrophe consistently
  for (const group of CHAR_VARIANT_GROUPS) {
    const positionsInGroup = positions.filter(p => p.group === group);
    if (positionsInGroup.length === 0) continue;
    
    // Try replacing all instances with each variant in the group
    for (const targetChar of group) {
      let modified = query;
      for (const pos of positionsInGroup) {
        modified = modified.replace(pos.char, targetChar);
      }
      addVariant(modified);
    }
  }
  
  return variants;
}

/**
 * Check if a string contains any special characters that have variants
 * Useful for conditionally showing hints about character normalization
 * 
 * @param str The string to check
 * @returns true if the string contains any characters from CHAR_VARIANT_GROUPS
 */
export function hasSpecialChars(str: string): boolean {
  for (const group of CHAR_VARIANT_GROUPS) {
    for (const char of group) {
      if (str.includes(char)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if a title is primarily English/Latin characters
 * Used for prioritizing English titles in search order
 * 
 * @param title The title to check
 * @returns true if the title is primarily Latin characters
 */
export function isEnglishTitle(title: string): boolean {
  // Count Latin alphabet characters vs non-ASCII characters
  const latinChars = (title.match(/[a-zA-Z]/g) || []).length;
  const nonLatinChars = (title.match(/[^\x00-\x7F]/g) || []).length;
  
  // If no letters at all, consider it neutral (treat as English)
  if (latinChars === 0 && nonLatinChars === 0) return true;
  
  // Primarily English if more Latin than non-Latin
  return latinChars >= nonLatinChars;
}
