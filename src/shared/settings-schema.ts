import type { GlobalSettings } from '@/types';

/**
 * Single source of truth for global-setting definitions (labels, ranges,
 * options, grouping). Any surface that edits GlobalSettings should render
 * from this schema; UIs can differ, definitions must not.
 *
 * Currently consumed by the dashboard settings tab. The viewer's
 * SettingsPanel predates this file and still hand-rolls the same fields;
 * migrating it onto this schema is tracked in tasks/todo.md (polish phase).
 * Until then, changes to setting constraints must be made here AND checked
 * against SettingsPanel.
 */

export type SettingField =
  | { kind: 'toggle'; key: keyof GlobalSettings; label: string; desc: string }
  | { kind: 'select'; key: keyof GlobalSettings; label: string; desc: string; options: Array<{ value: string; label: string }> }
  | { kind: 'number'; key: keyof GlobalSettings; label: string; desc: string; min: number; max: number; step?: number; unit?: string }
  | { kind: 'range'; key: keyof GlobalSettings; label: string; desc: string; min: number; max: number; step?: number };

export interface SettingsSection {
  title: string;
  fields: SettingField[];
}

/** Keys that must also be pushed to the background image cache when changed */
export const CACHE_SETTING_KEYS: Array<keyof GlobalSettings> = [
  'enableImageCache',
  'imageCacheTTLDays',
  'imageCacheMaxSizeMB',
  'imageCacheEvictionUnit',
  'imageCacheEvictionPriority',
];

// Note: there is no defaultSource field here. Source priority lives in
// source_config (dashboard Sources tab); the first enabled source is the
// default. GlobalSettings.defaultSource remains in the type only for
// storage back-compat (it seeds the initial priority order once).
export function buildSettingsSchema(): SettingsSection[] {
  return [
    {
      title: 'Reading',
      fields: [
        {
          kind: 'select', key: 'defaultReadingMode', label: 'Reading mode',
          desc: 'Default for manga without their own override',
          options: [
            { value: 'vertical', label: 'Vertical scroll' },
            { value: 'single', label: 'Single page' },
            { value: 'double', label: 'Double page' },
          ],
        },
        {
          kind: 'select', key: 'defaultImageFit', label: 'Image fit',
          desc: 'How pages are sized in the reader',
          // 'height' and 'contain' exist in the type but are disabled in the
          // reader (broken, see SettingsPanel TODO). Don't offer them here.
          options: [
            { value: 'width', label: 'Fit width' },
            { value: 'original', label: 'Original size' },
          ],
        },
        {
          kind: 'select', key: 'backgroundColor', label: 'Background',
          desc: 'Reader backdrop color',
          options: [
            { value: '#000000', label: 'Black' },
            { value: '#0a0a0a', label: 'Near black' },
            { value: '#1a1a1a', label: 'Dark gray' },
            { value: '#ffffff', label: 'White' },
          ],
        },
        { kind: 'toggle', key: 'continuousReading', label: 'Continuous reading', desc: 'Auto-load the next chapter into one endless strip (vertical mode)' },
        { kind: 'range', key: 'scrollAmount', label: 'Scroll amount', desc: '% of screen per key press or tap', min: 5, max: 100 },
        { kind: 'range', key: 'scrollSpeed', label: 'Scroll speed', desc: 'Smooth-scroll animation speed', min: 1, max: 10, step: 0.1 },
        { kind: 'number', key: 'preloadPages', label: 'Preload pages', desc: 'Pages fetched ahead while reading', min: 0, max: 20 },
      ],
    },
    {
      title: 'Interface',
      fields: [
        { kind: 'toggle', key: 'toolbarAutoHide', label: 'Auto-hide toolbar', desc: 'Hide the reader toolbar while idle' },
        { kind: 'number', key: 'toolbarHideDelay', label: 'Toolbar hide delay', desc: 'Idle time before the toolbar hides', min: 500, max: 15000, step: 500, unit: 'ms' },
        { kind: 'toggle', key: 'scrollbarAutoHide', label: 'Auto-hide scrollbar', desc: 'Hide the reader scrollbar while idle' },
        { kind: 'toggle', key: 'keyboardShortcutsEnabled', label: 'Keyboard shortcuts', desc: 'Arrow keys, space, and navigation shortcuts' },
      ],
    },
    {
      title: 'Behavior',
      fields: [
        { kind: 'toggle', key: 'rememberChapter', label: 'Remember chapter', desc: 'Reopen the manga at the last chapter you read' },
        { kind: 'toggle', key: 'rememberPerChapterPosition', label: 'Remember position', desc: 'Restore your scroll position within each chapter' },
        { kind: 'toggle', key: 'resumePositionOnReadChapter', label: 'Resume on "Read This Chapter"', desc: 'Restore position even when opening a specific chapter' },
        {
          kind: 'select', key: 'markReadMode', label: 'Mark chapters read',
          desc: 'When a chapter counts as read',
          options: [
            { value: 'onOpen', label: 'When opened' },
            { value: 'onNextChapter', label: 'On next chapter' },
          ],
        },
      ],
    },
    {
      title: 'Image cache',
      fields: [
        { kind: 'toggle', key: 'enableImageCache', label: 'Cache pages', desc: 'Store pages locally for instant re-reads' },
        { kind: 'number', key: 'imageCacheTTLDays', label: 'Keep for', desc: 'Days before cached pages expire (0 = forever)', min: 0, max: 365, unit: 'days' },
        { kind: 'number', key: 'imageCacheMaxSizeMB', label: 'Max size', desc: 'Cache size limit before eviction', min: 64, max: 16384, step: 64, unit: 'MB' },
        {
          kind: 'select', key: 'imageCacheEvictionUnit', label: 'Evict by',
          desc: 'Granularity when making room',
          options: [
            { value: 'chapter', label: 'Chapter' },
            { value: 'manga', label: 'Whole manga' },
            { value: 'image', label: 'Single image' },
          ],
        },
        {
          kind: 'select', key: 'imageCacheEvictionPriority', label: 'Evict first',
          desc: 'What gets removed when the cache is full',
          options: [
            { value: 'lru', label: 'Least recently read' },
            { value: 'oldest', label: 'Oldest cached' },
          ],
        },
        { kind: 'toggle', key: 'imageCacheEvictionNotifications', label: 'Eviction notices', desc: 'Show a toast in the reader when pages are evicted' },
      ],
    },
  ];
}
