import { GlobalSettings, DEFAULT_SETTINGS, ReadingMode, ImageFit, BackgroundColor, MarkReadMode, MangaSourceMapping, MangaDetails } from '@/types';
import { settingsManager } from '@/core';
import { sourceRegistry } from '@/sources';
import { bridgeCacheStats, bridgeCacheClear, bridgeSourceDataClearAll, bridgeSourceDataStats } from '@/utils/bridge';
import { formatBytes, formatMB } from '@/utils/format';
import { setupBackdropClose } from '@/utils/backdrop-close';
import { cacheManager } from './CacheManager';
import { slugEditor } from './SlugEditor';

/**
 * SettingsPanel - Full settings configuration modal
 * 
 * Allows users to configure:
 * - Default reading mode
 * - Image fit preference
 * - Keyboard shortcuts toggle
 * - Position memory settings
 * - Toolbar auto-hide
 * - Background color
 */
export class SettingsPanel {
  private container: HTMLElement | null = null;
  private settings: GlobalSettings = { ...DEFAULT_SETTINGS };
  private hasChanges: boolean = false;  // Track if changes made
  private isOpen: boolean = false;  // Track open state for toggle behavior
  
  private onClose?: () => void;
  private onSettingsChange?: (settings: GlobalSettings) => void;
  private onSourceSlugChange?: (newSlug: string, details: MangaDetails) => void;
  private onSourceChange?: (newSourceId: string) => void;
  
  // Source mapping info
  private sourceMapping: MangaSourceMapping | null = null;
  private currentSourceId: string = 'asura';

  /**
   * Show the settings panel
   */
  async show(
    onSettingsChange?: (settings: GlobalSettings) => void,
    onClose?: () => void,
    sourceMapping?: MangaSourceMapping | null,
    currentSourceId?: string,
    onSourceSlugChange?: (newSlug: string, details: MangaDetails) => void,
    onSourceChange?: (newSourceId: string) => void
  ): Promise<void> {
    // Toggle behavior - close if already open
    if (this.isOpen) {
      this.hide();
      return;
    }
    
    this.onSettingsChange = onSettingsChange;
    this.onClose = onClose;
    this.onSourceSlugChange = onSourceSlugChange;
    this.onSourceChange = onSourceChange;
    this.sourceMapping = sourceMapping || null;
    this.currentSourceId = currentSourceId || 'asura';
    this.hasChanges = false;

    // Load current settings
    this.settings = await settingsManager.load();

    this.createModal();
    this.isOpen = true;
  }

  /**
   * Hide the panel
   */
  hide(): void {
    this.container?.remove();
    this.container = null;
    this.isOpen = false;
    document.removeEventListener('keydown', this.handleKeydown);
  }

  /**
   * Create modal DOM
   */
  private createModal(): void {
    document.getElementById('cr-settings-panel')?.remove();

    this.container = document.createElement('div');
    this.container.id = 'cr-settings-panel';
    this.container.className = 'cr-settings-overlay';
    this.container.innerHTML = `
      <div class="cr-settings-modal">
        <div class="cr-settings-header">
          <h3>Settings</h3>
          <button class="cr-settings-close" id="cr-settings-close">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
        
        <div class="cr-settings-body">
          <!-- Source Settings -->
          <section class="cr-settings-section">
            <h4>Source</h4>
            
            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Manga Source</label>
                <span class="cr-setting-desc">Source to fetch chapters from</span>
              </div>
              <select id="cr-setting-source" class="cr-setting-select">
                ${this.renderSourceOptions()}
              </select>
            </div>

            <div class="cr-slug-edit-row">
              <span class="cr-slug-current" id="cr-current-slug-display">${this.getCurrentSlug() || 'Not set'}</span>
              <a class="cr-slug-edit-link" id="cr-edit-slug-link">Edit slug</a>
            </div>
          </section>

          <!-- Reading Settings -->
          <section class="cr-settings-section">
            <h4>Reading</h4>
            
            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Default Reading Mode</label>
                <span class="cr-setting-desc">Mode when opening a new manga</span>
              </div>
              <select id="cr-setting-mode" class="cr-setting-select">
                <option value="vertical" ${this.settings.defaultReadingMode === 'vertical' ? 'selected' : ''}>Vertical Scroll</option>
                <option value="single" ${this.settings.defaultReadingMode === 'single' ? 'selected' : ''}>Single Page</option>
                <option value="double" ${this.settings.defaultReadingMode === 'double' ? 'selected' : ''}>Double Page</option>
              </select>
            </div>
            
            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Default Image Fit</label>
                <span class="cr-setting-desc">How images fit in the viewer</span>
              </div>
              <select id="cr-setting-fit" class="cr-setting-select">
                <option value="width" ${this.settings.defaultImageFit === 'width' ? 'selected' : ''}>Fit Width</option>
                <!-- TODO: Fix height and contain fit modes - they don't work correctly
                <option value="height" ${this.settings.defaultImageFit === 'height' ? 'selected' : ''}>Fit Height</option>
                <option value="contain" ${this.settings.defaultImageFit === 'contain' ? 'selected' : ''}>Contain</option>
                -->
                <option value="original" ${this.settings.defaultImageFit === 'original' ? 'selected' : ''}>Original Size</option>
              </select>
            </div>

            <div class="cr-setting-item cr-setting-item-stacked">
              <div class="cr-setting-item-top">
                <div class="cr-setting-info">
                  <label>Scroll Distance</label>
                  <span class="cr-setting-desc">How far each key press scrolls</span>
                </div>
                <span class="cr-slider-value" id="cr-scroll-amount-value">${this.settings.scrollAmount}%</span>
              </div>
              <div class="cr-slider-wrap">
                <input type="range" id="cr-setting-scroll-amount" class="cr-setting-range" min="5" max="100" step="1" value="${this.settings.scrollAmount}">
                <div class="cr-slider-ticks">
                  <span class="cr-slider-tick" style="left:0%">5%</span>
                  <span class="cr-slider-tick" style="left:21.05%">25%</span>
                  <span class="cr-slider-tick" style="left:47.37%">50%</span>
                  <span class="cr-slider-tick" style="left:73.68%">75%</span>
                  <span class="cr-slider-tick" style="left:100%">100%</span>
                </div>
              </div>
            </div>

            <div class="cr-setting-item cr-setting-item-stacked">
              <div class="cr-setting-item-top">
                <div class="cr-setting-info">
                  <label>Scroll Speed</label>
                  <span class="cr-setting-desc">Animation speed</span>
                </div>
                <span class="cr-slider-value" id="cr-scroll-speed-value">${this.settings.scrollSpeed.toFixed(1)}</span>
              </div>
              <div class="cr-slider-wrap">
                <input type="range" id="cr-setting-scroll-speed" class="cr-setting-range" min="1" max="10" step="0.1" value="${this.settings.scrollSpeed}">
                <div class="cr-slider-labels">
                  <span class="cr-slider-label">Slow</span>
                  <span class="cr-slider-label">Fast</span>
                </div>
              </div>
            </div>
          </section>
          
          <!-- Behavior Settings -->
          <section class="cr-settings-section">
            <h4>Behavior</h4>

            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Mark Chapter as Read</label>
                <span class="cr-setting-desc">When to mark a chapter as read</span>
              </div>
              <div class="cr-segmented-toggle" id="cr-setting-mark-read">
                <button class="cr-segmented-option ${this.settings.markReadMode === 'onOpen' ? 'active' : ''}" data-value="onOpen">Read on Open</button>
                <button class="cr-segmented-option ${this.settings.markReadMode === 'onNextChapter' ? 'active' : ''}" data-value="onNextChapter">Read on Next Chapter</button>
              </div>
            </div>

            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Continuous Reading</label>
                <span class="cr-setting-desc">Auto-load next chapter when reaching the end (vertical mode)</span>
              </div>
              <label class="cr-toggle">
                <input type="checkbox" id="cr-setting-continuous-reading" ${this.settings.continuousReading ? 'checked' : ''}>
                <span class="cr-toggle-slider"></span>
              </label>
            </div>

            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Remember Reading Position</label>
                <span class="cr-setting-desc">Return to where you stopped when reopening a chapter. The green "Continue Reading" button always resumes regardless of this setting.</span>
              </div>
              <label class="cr-toggle">
                <input type="checkbox" id="cr-setting-remember-position" ${this.settings.rememberPerChapterPosition ? 'checked' : ''}>
                <span class="cr-toggle-slider"></span>
              </label>
            </div>

            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Resume on "Read This Chapter"</label>
                <span class="cr-setting-desc">The purple "Read This Chapter" button on ComicK normally starts from page 1. Enable to make it resume from your saved position instead.</span>
              </div>
              <label class="cr-toggle">
                <input type="checkbox" id="cr-setting-resume-on-read" ${this.settings.resumePositionOnReadChapter ? 'checked' : ''}>
                <span class="cr-toggle-slider"></span>
              </label>
            </div>
          </section>
          
          <!-- Cache Settings -->
          <section class="cr-settings-section">
            <h4>Image Cache</h4>
            
            <div class="cr-setting-item cr-cache-stats" id="cr-cache-stats-container">
              <div class="cr-setting-info">
                <label>Cache Usage</label>
                <span class="cr-setting-desc" id="cr-cache-stats">Loading...</span>
              </div>
              <div class="cr-cache-actions">
                <a class="cr-cache-details-link" id="cr-cache-details-link">View details</a>
                <button class="cr-settings-btn-small" id="cr-clear-cache">Clear Cache</button>
              </div>
            </div>
          </section>
          
          <!-- UI Settings -->
          <section class="cr-settings-section">
            <h4>Interface</h4>
            
            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Auto-hide Toolbar</label>
                <span class="cr-setting-desc">Hide on scroll, show when mouse enters top area</span>
              </div>
              <label class="cr-toggle">
                <input type="checkbox" id="cr-setting-autohide" ${this.settings.toolbarAutoHide ? 'checked' : ''}>
                <span class="cr-toggle-slider"></span>
              </label>
            </div>

            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Auto-hide Scrollbar</label>
                <span class="cr-setting-desc">Hide scrollbar unless mouse hovers the right edge</span>
              </div>
              <label class="cr-toggle">
                <input type="checkbox" id="cr-setting-scrollbar-autohide" ${this.settings.scrollbarAutoHide ? 'checked' : ''}>
                <span class="cr-toggle-slider"></span>
              </label>
            </div>
            
            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Keyboard Shortcuts</label>
                <span class="cr-setting-desc">Enable WASD/Space navigation</span>
              </div>
              <label class="cr-toggle">
                <input type="checkbox" id="cr-setting-keyboard" ${this.settings.keyboardShortcutsEnabled ? 'checked' : ''}>
                <span class="cr-toggle-slider"></span>
              </label>
            </div>
            
            <div class="cr-setting-item">
              <div class="cr-setting-info">
                <label>Background Color</label>
                <span class="cr-setting-desc">Reader background color</span>
              </div>
              <div class="cr-color-options">
                <button class="cr-color-btn ${this.settings.backgroundColor === '#000000' ? 'active' : ''}" data-color="#000000" style="background: #000000" title="Black"></button>
                <button class="cr-color-btn ${this.settings.backgroundColor === '#0a0a0a' ? 'active' : ''}" data-color="#0a0a0a" style="background: #0a0a0a" title="Dark Gray"></button>
                <button class="cr-color-btn ${this.settings.backgroundColor === '#1a1a1a' ? 'active' : ''}" data-color="#1a1a1a" style="background: #1a1a1a" title="Gray"></button>
                <button class="cr-color-btn ${this.settings.backgroundColor === '#ffffff' ? 'active' : ''}" data-color="#ffffff" style="background: #ffffff" title="White"></button>
              </div>
            </div>
          </section>
          
          <!-- Keyboard Shortcuts Reference -->
          <section class="cr-settings-section">
            <h4>Keyboard Shortcuts</h4>
            <div class="cr-shortcuts-grid">
              <div class="cr-shortcut-item"><kbd>Esc</kbd><span>Close viewer</span></div>
              <div class="cr-shortcut-item"><kbd>W</kbd> / <kbd>S</kbd><span>Previous/Next page</span></div>
              <div class="cr-shortcut-item"><kbd>A</kbd> / <kbd>D</kbd><span>Previous/Next chapter</span></div>
              <div class="cr-shortcut-item"><kbd>Space</kbd><span>Scroll down</span></div>
              <div class="cr-shortcut-item"><kbd>Shift+Space</kbd><span>Scroll up</span></div>
              <div class="cr-shortcut-item"><kbd>F</kbd><span>Fullscreen</span></div>
              <div class="cr-shortcut-item"><kbd>G</kbd><span>Open settings</span></div>
              <div class="cr-shortcut-item"><kbd>T</kbd><span>Toggle toolbar</span></div>
              <div class="cr-shortcut-item"><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd><span>Vertical/Single/Double mode</span></div>
            </div>
          </section>
        </div>
        
        <div class="cr-settings-footer">
          <button class="cr-settings-reset" id="cr-settings-reset">Reset to Defaults</button>
          <div class="cr-settings-actions">
            <button class="cr-settings-cancel" id="cr-settings-cancel">Cancel</button>
            <button class="cr-settings-save" id="cr-settings-save">Save</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.container);
    this.setupEventListeners();
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Close button
    document.getElementById('cr-settings-close')?.addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });

    // Click outside to close
    if (this.container) {
      setupBackdropClose(this.container, () => {
        this.hide();
        this.onClose?.();
      });
    }

    // Cancel button
    document.getElementById('cr-settings-cancel')?.addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });

    // Save button
    document.getElementById('cr-settings-save')?.addEventListener('click', () => {
      this.saveSettings();
    });

    // Reset button
    document.getElementById('cr-settings-reset')?.addEventListener('click', () => {
      this.resetToDefaults();
    });

    // Edit slug link — opens SlugEditor dialog
    document.getElementById('cr-edit-slug-link')?.addEventListener('click', () => {
      slugEditor.show(this.currentSourceId, this.getCurrentSlug(), (newSlug, details) => {
        const display = document.getElementById('cr-current-slug-display');
        if (display) display.textContent = newSlug;
        this.onSourceSlugChange?.(newSlug, details);
        this.hide();
        this.onClose?.();
      });
    });

    // Source change listener (migration flow)
    document.getElementById('cr-setting-source')?.addEventListener('change', async (e) => {
      const select = e.target as HTMLSelectElement;
      const newSourceId = select.value;
      if (newSourceId === this.currentSourceId) return;

      const source = sourceRegistry.get(newSourceId);
      const sourceName = source?.name || newSourceId;

      const confirmed = await this.showConfirmDialog(
        'Change Source?',
        `Search for this manga on ${sourceName} and link to the new source.\n\nThe current source link will be kept as a fallback.`,
        'Change Source',
        'Cancel'
      );

      if (confirmed) {
        this.onSourceChange?.(newSourceId);
        this.hide();
        this.onClose?.();
      } else {
        // Revert dropdown
        select.value = this.currentSourceId;
      }
    });

    // Reading mode select
    document.getElementById('cr-setting-mode')?.addEventListener('change', (e) => {
      this.settings.defaultReadingMode = (e.target as HTMLSelectElement).value as ReadingMode;
      this.hasChanges = true;
    });

    // Image fit select
    document.getElementById('cr-setting-fit')?.addEventListener('change', (e) => {
      this.settings.defaultImageFit = (e.target as HTMLSelectElement).value as ImageFit;
      this.hasChanges = true;
    });

    // Scroll distance slider
    document.getElementById('cr-setting-scroll-amount')?.addEventListener('input', (e) => {
      const value = parseInt((e.target as HTMLInputElement).value);
      this.settings.scrollAmount = value;
      this.hasChanges = true;
      const label = document.getElementById('cr-scroll-amount-value');
      if (label) label.textContent = `${value}%`;
    });

    // Scroll speed slider (direct 1–10 range, no conversion)
    document.getElementById('cr-setting-scroll-speed')?.addEventListener('input', (e) => {
      const value = parseFloat((e.target as HTMLInputElement).value);
      this.settings.scrollSpeed = value;
      this.hasChanges = true;
      const label = document.getElementById('cr-scroll-speed-value');
      if (label) label.textContent = value.toFixed(1);
    });

    // Mark read segmented toggle
    document.getElementById('cr-setting-mark-read')?.querySelectorAll('.cr-segmented-option').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const value = (e.currentTarget as HTMLElement).dataset.value as MarkReadMode;
        this.settings.markReadMode = value;
        this.hasChanges = true;
        // Update active state
        document.getElementById('cr-setting-mark-read')?.querySelectorAll('.cr-segmented-option').forEach(b => {
          b.classList.toggle('active', (b as HTMLElement).dataset.value === value);
        });
      });
    });

    // Continuous reading toggle
    document.getElementById('cr-setting-continuous-reading')?.addEventListener('change', (e) => {
      this.settings.continuousReading = (e.target as HTMLInputElement).checked;
      this.hasChanges = true;
    });

    // Toggle switches
    document.getElementById('cr-setting-remember-position')?.addEventListener('change', (e) => {
      this.settings.rememberPerChapterPosition = (e.target as HTMLInputElement).checked;
      this.hasChanges = true;
    });

    document.getElementById('cr-setting-resume-on-read')?.addEventListener('change', (e) => {
      this.settings.resumePositionOnReadChapter = (e.target as HTMLInputElement).checked;
      this.hasChanges = true;
    });

    document.getElementById('cr-setting-autohide')?.addEventListener('change', (e) => {
      this.settings.toolbarAutoHide = (e.target as HTMLInputElement).checked;
      this.hasChanges = true;
    });

    document.getElementById('cr-setting-scrollbar-autohide')?.addEventListener('change', (e) => {
      this.settings.scrollbarAutoHide = (e.target as HTMLInputElement).checked;
      this.hasChanges = true;
    });

    document.getElementById('cr-setting-keyboard')?.addEventListener('change', (e) => {
      this.settings.keyboardShortcutsEnabled = (e.target as HTMLInputElement).checked;
      this.hasChanges = true;
    });

    // View cache details link
    document.getElementById('cr-cache-details-link')?.addEventListener('click', () => {
      cacheManager.show(() => {
        this.loadCacheStats();
      });
    });

    // Clear cache button
    document.getElementById('cr-clear-cache')?.addEventListener('click', async () => {
      const confirmed = await this.showConfirmDialog(
        'Clear All Cache?',
        'This will delete all cached manga pages and chapter data. You will need to re-download images when reading.\n\nThis action cannot be undone.',
        'Clear Cache',
        'Cancel'
      );
      
      if (!confirmed) return;
      
      const btn = document.getElementById('cr-clear-cache') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Clearing...';
      
      try {
        // Clear both image cache and source data cache
        await Promise.all([
          bridgeCacheClear(),
          bridgeSourceDataClearAll(),
        ]);
        this.loadCacheStats();
        console.log('[Settings] All caches cleared');
      } catch (error) {
        console.error('[Settings] Failed to clear cache:', error);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Clear Cache';
      }
    });

    // Load cache stats
    this.loadCacheStats();

    // Color buttons
    this.container?.querySelectorAll('.cr-color-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const color = (e.currentTarget as HTMLElement).dataset.color as BackgroundColor;
        this.settings.backgroundColor = color;
        this.hasChanges = true;

        // Update UI
        this.container?.querySelectorAll('.cr-color-btn').forEach(b => b.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
      });
    });

    // Keyboard
    document.addEventListener('keydown', this.handleKeydown);
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.hide();
      this.onClose?.();
    }
  };

  /**
   * Save settings
   */
  private async saveSettings(): Promise<void> {
    await settingsManager.save(this.settings);
    this.onSettingsChange?.(this.settings);
    this.hide();
    this.onClose?.();
  }

  /**
   * Reset to defaults
   */
  private resetToDefaults(): void {
    this.settings = { ...DEFAULT_SETTINGS };
    this.hasChanges = true;
    
    // Update UI
    (document.getElementById('cr-setting-mode') as HTMLSelectElement).value = this.settings.defaultReadingMode;
    (document.getElementById('cr-setting-fit') as HTMLSelectElement).value = this.settings.defaultImageFit;
    (document.getElementById('cr-setting-scroll-amount') as HTMLInputElement).value = String(this.settings.scrollAmount);
    const amountLabel = document.getElementById('cr-scroll-amount-value');
    if (amountLabel) amountLabel.textContent = `${this.settings.scrollAmount}%`;
    (document.getElementById('cr-setting-scroll-speed') as HTMLInputElement).value = String(this.settings.scrollSpeed);
    const speedLabel = document.getElementById('cr-scroll-speed-value');
    if (speedLabel) speedLabel.textContent = this.settings.scrollSpeed.toFixed(1);
    (document.getElementById('cr-setting-remember-position') as HTMLInputElement).checked = this.settings.rememberPerChapterPosition;
    (document.getElementById('cr-setting-resume-on-read') as HTMLInputElement).checked = this.settings.resumePositionOnReadChapter;
    (document.getElementById('cr-setting-continuous-reading') as HTMLInputElement).checked = this.settings.continuousReading;
    // Update mark read segmented toggle
    document.getElementById('cr-setting-mark-read')?.querySelectorAll('.cr-segmented-option').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.value === this.settings.markReadMode);
    });
    (document.getElementById('cr-setting-autohide') as HTMLInputElement).checked = this.settings.toolbarAutoHide;
    (document.getElementById('cr-setting-scrollbar-autohide') as HTMLInputElement).checked = this.settings.scrollbarAutoHide;
    (document.getElementById('cr-setting-keyboard') as HTMLInputElement).checked = this.settings.keyboardShortcutsEnabled;
    
    // Update color buttons
    this.container?.querySelectorAll('.cr-color-btn').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.color === this.settings.backgroundColor);
    });
  }

  /**
   * Show a confirmation dialog
   */
  private showConfirmDialog(
    title: string,
    message: string,
    confirmText: string,
    cancelText: string
  ): Promise<boolean> {
    return new Promise((resolve) => {
      // Remove any existing dialog
      document.getElementById('cr-confirm-dialog')?.remove();
      
      const dialog = document.createElement('div');
      dialog.id = 'cr-confirm-dialog';
      dialog.className = 'cr-confirm-overlay';
      dialog.innerHTML = `
        <div class="cr-confirm-modal">
          <div class="cr-confirm-header">
            <h4>${title}</h4>
          </div>
          <div class="cr-confirm-body">
            <p>${message.replace(/\n/g, '<br>')}</p>
          </div>
          <div class="cr-confirm-footer">
            <button class="cr-confirm-cancel" id="cr-confirm-cancel">${cancelText}</button>
            <button class="cr-confirm-ok" id="cr-confirm-ok">${confirmText}</button>
          </div>
        </div>
      `;
      
      document.body.appendChild(dialog);
      
      const cleanup = (result: boolean) => {
        dialog.remove();
        resolve(result);
      };
      
      document.getElementById('cr-confirm-ok')?.addEventListener('click', () => cleanup(true));
      document.getElementById('cr-confirm-cancel')?.addEventListener('click', () => cleanup(false));
      
      // Click outside to cancel
      setupBackdropClose(dialog, () => cleanup(false));
      
      // Escape to cancel
      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopImmediatePropagation();
          document.removeEventListener('keydown', handleEsc);
          cleanup(false);
        }
      };
      document.addEventListener('keydown', handleEsc);
    });
  }

  /**
   * Load and display cache statistics
   */
  private async loadCacheStats(): Promise<void> {
    const statsEl = document.getElementById('cr-cache-stats');
    if (!statsEl) return;

    try {
      const stats = await bridgeCacheStats();
      const sizeText = formatBytes(stats.totalSizeMB * 1024 * 1024);

      statsEl.textContent = `${stats.entryCount} pages cached (${sizeText} / ${formatMB(stats.maxSizeMB)} max)`;
    } catch (error) {
      statsEl.textContent = 'Unable to load cache stats';
      console.error('[Settings] Failed to load cache stats:', error);
    }
  }

  /**
   * Render source dropdown options dynamically from registry
   */
  private renderSourceOptions(): string {
    const sources = sourceRegistry.getAll();
    return sources.map(source => `
      <option value="${source.id}" ${source.id === this.currentSourceId ? 'selected' : ''}>
        ${source.name}
      </option>
    `).join('');
  }

  /**
   * Get current source slug
   */
  private getCurrentSlug(): string {
    if (!this.sourceMapping || !this.sourceMapping.sources[this.currentSourceId]) {
      return '';
    }
    return this.sourceMapping.sources[this.currentSourceId].slug || '';
  }

}

export const settingsPanel = new SettingsPanel();
