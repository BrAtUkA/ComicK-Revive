import { Chapter, MangaReadingState, ReadingPosition } from '@/types';
import { readingStateManager } from '@/core';
import { bridgeGetChapterPageCount } from '@/utils';
import { setupBackdropClose } from '@/utils/backdrop-close';

/**
 * Cache context for checking if chapters are fully cached
 */
interface CacheContext {
  sourceId: string;
  mangaSlug: string;
}

/**
 * ChapterPicker - Modal for browsing and selecting chapters
 * 
 * Features:
 * - Grid/list view of all chapters
 * - Search/filter chapters
 * - Shows read status
 * - Shows reading progress (e.g., "5/19") for partially read chapters
 * - Shows cache indicator for fully cached chapters
 * - Context menu for chapter actions
 * - Keyboard navigation
 * - Refresh button to invalidate chapter cache
 */
export class ChapterPicker {
  private container: HTMLElement | null = null;
  private contextMenu: HTMLElement | null = null;
  private confirmModal: HTMLElement | null = null;
  private chapters: Chapter[] = [];
  private currentChapter: number = 1;
  private filteredChapters: Chapter[] = [];
  private readChapters: Set<number> = new Set();
  private comickSlug: string = '';
  private sourceId: string = '';
  
  // Reading state for progress display
  private readingState: MangaReadingState | null = null;
  private sourcePositions: Record<number, ReadingPosition> | undefined;
  private sourcePageCounts: Record<number, number> | undefined;
  
  // Cache context for checking cached chapters
  private cacheContext: CacheContext | null = null;
  
  // Cached chapters set (populated async)
  private cachedChapters: Set<number> = new Set();
  
  // Abort flag for cache checking
  private cacheCheckAborted: boolean = false;
  
  private onSelect?: (chapter: Chapter) => void;
  private onClose?: () => void;
  private onRefresh?: () => Promise<void>;
  private onStartFromBeginning?: (chapter: Chapter) => void;
  private isRefreshing = false;

  /**
   * Show the chapter picker
   */
  async show(
    chapters: Chapter[],
    currentChapter: number,
    onSelect: (chapter: Chapter) => void,
    onClose?: () => void,
    onRefresh?: () => Promise<void>,
    comickSlug?: string,
    onStartFromBeginning?: (chapter: Chapter) => void,
    cacheContext?: CacheContext,
    sourceId?: string
  ): Promise<void> {
    this.chapters = chapters;
    this.currentChapter = currentChapter;
    // Sort chapters ascending (chapter 0/1 at top, newest at bottom)
    this.filteredChapters = [...chapters].sort((a, b) => a.number - b.number);
    this.onSelect = onSelect;
    this.onClose = onClose;
    this.onRefresh = onRefresh;
    this.comickSlug = comickSlug || '';
    this.sourceId = sourceId || '';
    this.onStartFromBeginning = onStartFromBeginning;
    this.cacheContext = cacheContext || null;

    // Load read chapters and reading state
    if (this.comickSlug) {
      const readChapters = await readingStateManager.getReadChapters(this.comickSlug);
      this.readChapters = new Set(readChapters);

      // Load full reading state for progress display
      this.readingState = await readingStateManager.get(this.comickSlug);
      if (this.readingState && this.sourceId) {
        this.sourcePositions = readingStateManager.getSourcePositions(this.readingState, this.sourceId);
        this.sourcePageCounts = readingStateManager.getSourcePageCounts(this.readingState, this.sourceId);
      } else {
        this.sourcePositions = undefined;
        this.sourcePageCounts = undefined;
      }
    } else {
      this.readChapters = new Set();
      this.readingState = null;
      this.sourcePositions = undefined;
      this.sourcePageCounts = undefined;
    }
    
    // Reset cached chapters set and abort flag
    this.cachedChapters = new Set();
    this.cacheCheckAborted = false;

    this.createModal();
    this.scrollToCurrentChapter();
    
    // Check cache status asynchronously (don't block modal opening)
    // Only check chapters near the current chapter to avoid overwhelming IndexedDB
    this.checkCacheStatusAsync();
  }
  
  /**
   * Check cache status for chapters asynchronously
   * Checks chapters near the current chapter first
   * Uses image cache page count directly (works even if source data page URLs were deleted)
   * Updates UI as cache status is determined
   */
  private async checkCacheStatusAsync(): Promise<void> {
    if (!this.cacheContext) return;

    const { sourceId, mangaSlug } = this.cacheContext;

    // Sort chapters by proximity to current chapter (check nearby chapters first)
    const sortedChapters = [...this.chapters].sort((a, b) => {
      const distA = Math.abs(a.number - this.currentChapter);
      const distB = Math.abs(b.number - this.currentChapter);
      return distA - distB;
    });

    // Check all chapters (batched to avoid overwhelming IndexedDB)
    const BATCH_SIZE = 10;
    for (let i = 0; i < sortedChapters.length; i += BATCH_SIZE) {
      if (this.cacheCheckAborted || !this.container) return;

      const batch = sortedChapters.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (chapter) => {
        if (this.cacheCheckAborted || !this.container) return;

        try {
          // Check image cache directly (works even if source data page URLs were deleted)
          const { count, total } = await bridgeGetChapterPageCount(sourceId, mangaSlug, chapter.slug);

          if (this.cacheCheckAborted || !this.container) return;
          if (count > 0 && count === total) {
            this.cachedChapters.add(chapter.number);
            this.updateChapterCacheIndicator(chapter.number);
          }
        } catch {
          // Silently ignore cache check errors
        }
      }));
    }
  }
  
  /**
   * Update cache indicator for a specific chapter in the DOM
   * Adds 'visible' class to show the floppy icon
   */
  private updateChapterCacheIndicator(chapterNumber: number): void {
    const item = this.container?.querySelector(
      `.cr-chapter-item[data-chapter="${chapterNumber}"]`
    ) as HTMLElement;
    
    const indicator = item?.querySelector('.cr-chapter-cached');
    if (indicator && !indicator.classList.contains('visible')) {
      indicator.classList.add('visible');
    }
  }
  
  /**
   * Get the SVG markup for the cache indicator icon (small floppy disk)
   */
  private getCacheIndicatorSvg(): string {
    return `<svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
      <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>
    </svg>`;
  }

  /**
   * Hide the picker
   */
  hide(): void {
    // Abort any ongoing cache status checking
    this.cacheCheckAborted = true;
    
    this.hideContextMenu();
    this.container?.remove();
    this.container = null;
    document.removeEventListener('keydown', this.handleKeydown);
    document.removeEventListener('click', this.handleDocumentClick);
  }

  /**
   * Handle refresh button click
   */
  private async handleRefresh(): Promise<void> {
    if (this.isRefreshing || !this.onRefresh) return;

    this.isRefreshing = true;
    const refreshBtn = document.getElementById('cr-picker-refresh');
    const refreshIcon = refreshBtn?.querySelector('.cr-refresh-icon');
    
    // Add spinning animation
    refreshIcon?.classList.add('cr-refresh-spinning');
    
    try {
      await this.onRefresh();
    } catch (error) {
      console.error('[ChapterPicker] Refresh failed:', error);
    } finally {
      this.isRefreshing = false;
      refreshIcon?.classList.remove('cr-refresh-spinning');
    }
  }

  /**
   * Update chapter list (called after refresh)
   */
  updateChapters(chapters: Chapter[]): void {
    this.chapters = chapters;
    // Sort chapters ascending (chapter 0/1 at top, newest at bottom)
    this.filteredChapters = [...chapters].sort((a, b) => a.number - b.number);
    
    // Update count in info bar
    const infoBar = this.container?.querySelector('.cr-picker-info span:first-child');
    if (infoBar) {
      infoBar.textContent = `${chapters.length} chapters`;
    }
    
    // Re-render list
    const listContainer = document.getElementById('cr-chapter-list');
    if (listContainer) {
      listContainer.innerHTML = this.renderChapterList();
    }
    
    // Clear search
    const searchInput = document.getElementById('cr-chapter-search') as HTMLInputElement;
    if (searchInput) {
      searchInput.value = '';
    }

    // Re-check cache status for all chapters
    this.cachedChapters = new Set();
    this.cacheCheckAborted = false;
    this.checkCacheStatusAsync();
  }

  /**
   * Create modal DOM
   */
  private createModal(): void {
    document.getElementById('cr-chapter-picker')?.remove();

    this.container = document.createElement('div');
    this.container.id = 'cr-chapter-picker';
    this.container.className = 'cr-picker-overlay';
    this.container.innerHTML = `
      <div class="cr-picker-modal">
        <div class="cr-picker-header">
          <h3>Select Chapter</h3>
          <div class="cr-picker-search">
            <input 
              type="text" 
              id="cr-chapter-search" 
              placeholder="Search chapters..."
              class="cr-picker-search-input"
            >
          </div>
          ${this.onRefresh ? `
            <button class="cr-picker-refresh" id="cr-picker-refresh" title="Refresh chapter list">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" class="cr-refresh-icon">
                <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
              </svg>
            </button>
          ` : ''}
          <button class="cr-picker-close" id="cr-picker-close">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
        
        <div class="cr-picker-info">
          <span>${this.chapters.length} chapters</span>
          <span>Current: Ch. ${this.currentChapter}</span>
        </div>
        
        <div class="cr-picker-body" id="cr-chapter-list">
          ${this.renderChapterList()}
        </div>
      </div>
    `;

    document.body.appendChild(this.container);
    this.setupEventListeners();
  }

  /**
   * Clean chapter title by removing redundant chapter number prefix
   */
  private cleanTitle(title: string, chapterNumber: number): string {
    if (!title) return '';
    
    // Remove patterns like "Chapter 211", "Chapter211", "Ch. 211", "Ch.211" from start
    const patterns = [
      new RegExp(`^Chapter\\s*${chapterNumber}\\s*[-:]?\\s*`, 'i'),
      new RegExp(`^Ch\\.?\\s*${chapterNumber}\\s*[-:]?\\s*`, 'i'),
    ];
    
    let cleaned = title;
    for (const pattern of patterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    
    return cleaned.trim();
  }

  /**
   * Render chapter list
   */
  private renderChapterList(): string {
    if (this.filteredChapters.length === 0) {
      return `<div class="cr-picker-empty">No chapters found</div>`;
    }

    return this.filteredChapters.map(chapter => {
      const cleanedTitle = this.cleanTitle(chapter.title || '', chapter.number);
      const isRead = this.readChapters.has(chapter.number);
      const isCurrent = chapter.number === this.currentChapter;
      
      // Get progress info for this chapter
      const progressHtml = this.getProgressHtml(chapter.number, isCurrent, isRead);
      
      // Check if chapter is cached (already computed)
      const isCached = this.cachedChapters.has(chapter.number);
      
      return `
        <button 
          class="cr-chapter-item ${isCurrent ? 'current' : ''} ${isRead ? 'read' : ''}"
          data-chapter="${chapter.number}"
          data-slug="${chapter.slug}"
        >
          <span class="cr-chapter-cached ${isCached ? 'visible' : ''}" title="Cached for offline reading">
            ${this.getCacheIndicatorSvg()}
          </span>
          ${isRead ? `
            <span class="cr-chapter-read-indicator">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </span>
          ` : ''}
          <span class="cr-chapter-number">Ch. ${chapter.number}</span>
          ${cleanedTitle ? `<span class="cr-chapter-title">${cleanedTitle}</span>` : ''}
          ${progressHtml}
          ${isCurrent ? '<span class="cr-chapter-current-badge">Reading</span>' : ''}
        </button>
      `;
    }).join('');
  }
  
  /**
   * Get progress HTML for a chapter
   * Shows "currentPage/totalPages" for partially read chapters
   * Does NOT show for: current chapter, fully read chapters, unread chapters
   */
  private getProgressHtml(chapterNumber: number, isCurrent: boolean, isRead: boolean): string {
    // Don't show progress for current chapter (user is actively reading it)
    if (isCurrent) return '';
    
    // Don't show progress for fully read chapters
    if (isRead) return '';
    
    // Need reading state to show progress
    if (!this.readingState) return '';

    const position = this.sourcePositions?.[chapterNumber];
    const pageCount = this.sourcePageCounts?.[chapterNumber];
    
    // Need both position and page count
    if (!position || !pageCount) return '';
    
    // Calculate current page (1-indexed for display)
    const currentPage = position.anchorImageIndex + 1;
    
    // Only show if there's actual progress (not at start)
    if (currentPage <= 1 && position.anchorImageOffset < 0.1) return '';
    
    return `<span class="cr-chapter-progress">${currentPage}/${pageCount}</span>`;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Close button
    document.getElementById('cr-picker-close')?.addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });

    // Refresh button
    document.getElementById('cr-picker-refresh')?.addEventListener('click', () => {
      this.handleRefresh();
    });

    // Click outside to close
    if (this.container) {
      setupBackdropClose(this.container, () => {
        this.hide();
        this.onClose?.();
      });
    }

    // Prevent context menu from going through the overlay
    this.container?.addEventListener('contextmenu', (e) => {
      // Only allow default context menu on input fields
      if ((e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault();
      }
    });

    // Search input
    const searchInput = document.getElementById('cr-chapter-search') as HTMLInputElement;
    searchInput?.addEventListener('input', (e) => {
      this.filterChapters((e.target as HTMLInputElement).value);
    });
    searchInput?.focus();

    // Chapter items - left click
    document.getElementById('cr-chapter-list')?.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.cr-chapter-item') as HTMLElement;
      if (item) {
        const chapterNum = parseInt(item.dataset.chapter || '0');
        const chapter = this.chapters.find(c => c.number === chapterNum);
        if (chapter) {
          this.onSelect?.(chapter);
          this.hide();
        }
      }
    });

    // Chapter items - right click (context menu)
    document.getElementById('cr-chapter-list')?.addEventListener('contextmenu', (e) => {
      const item = (e.target as HTMLElement).closest('.cr-chapter-item') as HTMLElement;
      if (item) {
        e.preventDefault();
        const chapterNum = parseInt(item.dataset.chapter || '0');
        const chapter = this.chapters.find(c => c.number === chapterNum);
        if (chapter) {
          this.showContextMenu(e.clientX, e.clientY, chapter);
        }
      }
    });

    // Close context menu on any click
    document.addEventListener('click', this.handleDocumentClick);

    // Keyboard
    document.addEventListener('keydown', this.handleKeydown);
  }

  private handleDocumentClick = (): void => {
    this.hideContextMenu();
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.hideContextMenu();
      if (!this.contextMenu) {
        this.hide();
        this.onClose?.();
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTEXT MENU
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Show context menu for a chapter
   */
  private showContextMenu(x: number, y: number, chapter: Chapter): void {
    this.hideContextMenu();

    const isRead = this.readChapters.has(chapter.number);
    
    this.contextMenu = document.createElement('div');
    this.contextMenu.className = 'cr-context-menu';
    this.contextMenu.innerHTML = `
      <button class="cr-context-menu-item" data-action="toggle-read">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          ${isRead 
            ? '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>'
            : '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>'}
        </svg>
        <span>${isRead ? 'Mark as Unread' : 'Mark as Read'}</span>
      </button>
      <button class="cr-context-menu-item" data-action="mark-previous-read">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/>
        </svg>
        <span>Mark Previous as Read</span>
      </button>
      <button class="cr-context-menu-item" data-action="mark-previous-unread">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
        </svg>
        <span>Mark Previous as Unread</span>
      </button>
      <div class="cr-context-menu-divider"></div>
      <button class="cr-context-menu-item" data-action="mark-all-unread">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
        <span>Mark All as Unread</span>
      </button>
      <div class="cr-context-menu-divider"></div>
      <button class="cr-context-menu-item" data-action="start-beginning">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
        </svg>
        <span>Start from Beginning</span>
      </button>
    `;

    // Position menu (6 items + 2 dividers)
    const menuWidth = 200;
    const menuHeight = 240;
    const finalX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
    const finalY = y + menuHeight > window.innerHeight ? y - menuHeight : y;
    
    this.contextMenu.style.left = `${finalX}px`;
    this.contextMenu.style.top = `${finalY}px`;

    document.body.appendChild(this.contextMenu);

    // Setup context menu event listeners
    this.contextMenu.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest('.cr-context-menu-item') as HTMLElement;
      if (!item) return;

      const action = item.dataset.action;
      
      switch (action) {
        case 'toggle-read':
          await this.toggleChapterRead(chapter);
          break;
        case 'mark-previous-read':
          // Only show confirmation if there's mixed state before this chapter
          // (both read and unread chapters exist - could lose track of which were intentionally unread)
          if (this.hasMixedStateBefore(chapter.number)) {
            this.showConfirmModal(
              `Mark all chapters before Chapter ${chapter.number} as read?<br>Some are read, some are unread.`,
              async () => { await this.markPreviousAsRead(chapter); }
            );
          } else {
            await this.markPreviousAsRead(chapter);
          }
          break;
        case 'mark-previous-unread':
          // Only show confirmation if there's mixed state before this chapter
          // (uniform states can easily be toggled back)
          if (this.hasMixedStateBefore(chapter.number)) {
            this.showConfirmModal(
              `Mark all chapters before Chapter ${chapter.number} as unread?<br>Some are read, some are unread.`,
              async () => { await this.markPreviousAsUnread(chapter); }
            );
          } else {
            await this.markPreviousAsUnread(chapter);
          }
          break;
        case 'mark-all-unread':
          // Only show confirmation if there's mixed state across all chapters
          // (uniform states can easily be toggled back)
          if (this.hasMixedStateAll()) {
            this.showConfirmModal(
              'Mark all chapters as unread?<br>Some are read, some are unread.',
              async () => { await this.markAllAsUnread(); }
            );
          } else {
            await this.markAllAsUnread();
          }
          break;
        case 'start-beginning':
          this.onStartFromBeginning?.(chapter);
          this.hide();
          break;
      }

      this.hideContextMenu();
    });
  }

  /**
   * Hide context menu
   */
  private hideContextMenu(): void {
    this.contextMenu?.remove();
    this.contextMenu = null;
  }

  /**
   * Check if there's a mixed state (both read and unread) before a given chapter
   * Returns true only if BOTH read and unread chapters exist before this chapter
   */
  private hasMixedStateBefore(chapterNumber: number): boolean {
    let hasRead = false;
    let hasUnread = false;
    
    for (const ch of this.chapters) {
      if (ch.number < chapterNumber) {
        if (this.readChapters.has(ch.number)) {
          hasRead = true;
        } else {
          hasUnread = true;
        }
        // Early exit if we found both
        if (hasRead && hasUnread) return true;
      }
    }
    return false;
  }

  /**
   * Check if there's a mixed state (both read and unread) across all chapters
   * Returns true only if BOTH read and unread chapters exist
   */
  private hasMixedStateAll(): boolean {
    const hasRead = this.readChapters.size > 0;
    const hasUnread = this.chapters.some(ch => !this.readChapters.has(ch.number));
    return hasRead && hasUnread;
  }

  /**
   * Show confirmation modal for bulk operations
   */
  private showConfirmModal(message: string, onConfirm: () => Promise<void>): void {
    this.hideConfirmModal();
    
    this.confirmModal = document.createElement('div');
    this.confirmModal.className = 'cr-confirm-modal-overlay';
    this.confirmModal.innerHTML = `
      <div class="cr-confirm-modal">
        <p class="cr-confirm-message">${message}</p>
        <div class="cr-confirm-actions">
          <button class="cr-confirm-btn cr-confirm-cancel">Cancel</button>
          <button class="cr-confirm-btn cr-confirm-ok">Confirm</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(this.confirmModal);
    
    // Cancel button
    this.confirmModal.querySelector('.cr-confirm-cancel')?.addEventListener('click', () => {
      this.hideConfirmModal();
    });
    
    // Confirm button
    this.confirmModal.querySelector('.cr-confirm-ok')?.addEventListener('click', async () => {
      this.hideConfirmModal();
      await onConfirm();
    });
    
    // Click outside to cancel
    setupBackdropClose(this.confirmModal, () => {
      this.hideConfirmModal();
    });
  }

  /**
   * Hide confirmation modal
   */
  private hideConfirmModal(): void {
    this.confirmModal?.remove();
    this.confirmModal = null;
  }

  /**
   * Toggle read status for a chapter
   */
  private async toggleChapterRead(chapter: Chapter): Promise<void> {
    if (!this.comickSlug) return;

    const isRead = this.readChapters.has(chapter.number);
    
    if (isRead) {
      await readingStateManager.markChapterUnread(this.comickSlug, chapter.number);
      this.readChapters.delete(chapter.number);
    } else {
      await readingStateManager.markChapterRead(this.comickSlug, chapter.number);
      this.readChapters.add(chapter.number);
    }

    // Update the list
    const listContainer = document.getElementById('cr-chapter-list');
    if (listContainer) {
      listContainer.innerHTML = this.renderChapterList();
    }
  }

  /**
   * Mark all chapters before (not including) this one as read
   */
  private async markPreviousAsRead(chapter: Chapter): Promise<void> {
    if (!this.comickSlug) return;

    const allChapterNumbers = this.chapters.map(c => c.number);
    await readingStateManager.markChaptersUpToRead(this.comickSlug, chapter.number, allChapterNumbers);
    
    // Update local read set
    for (const ch of allChapterNumbers) {
      if (ch < chapter.number) {
        this.readChapters.add(ch);
      }
    }

    // Update the list
    const listContainer = document.getElementById('cr-chapter-list');
    if (listContainer) {
      listContainer.innerHTML = this.renderChapterList();
    }
  }

  /**
   * Mark all chapters before (not including) this one as unread
   */
  private async markPreviousAsUnread(chapter: Chapter): Promise<void> {
    if (!this.comickSlug) return;

    await readingStateManager.markChaptersUpToUnread(this.comickSlug, chapter.number);
    
    // Update local read set
    for (const ch of this.chapters) {
      if (ch.number < chapter.number) {
        this.readChapters.delete(ch.number);
      }
    }

    // Update the list
    const listContainer = document.getElementById('cr-chapter-list');
    if (listContainer) {
      listContainer.innerHTML = this.renderChapterList();
    }
  }

  /**
   * Mark all chapters as unread
   */
  private async markAllAsUnread(): Promise<void> {
    if (!this.comickSlug) return;

    await readingStateManager.markAllUnread(this.comickSlug);
    
    // Clear local read set
    this.readChapters.clear();

    // Update the list
    const listContainer = document.getElementById('cr-chapter-list');
    if (listContainer) {
      listContainer.innerHTML = this.renderChapterList();
    }
  }

  /**
   * Filter chapters by search term
   */
  private filterChapters(query: string): void {
    const term = query.toLowerCase().trim();
    
    if (!term) {
      // Sort chapters ascending (chapter 0/1 at top, newest at bottom)
      this.filteredChapters = [...this.chapters].sort((a, b) => a.number - b.number);
    } else {
      this.filteredChapters = this.chapters.filter(chapter => {
        const numMatch = chapter.number.toString().includes(term);
        const titleMatch = chapter.title?.toLowerCase().includes(term);
        return numMatch || titleMatch;
      // Sort ascending after filtering
      }).sort((a, b) => a.number - b.number);
    }

    const listContainer = document.getElementById('cr-chapter-list');
    if (listContainer) {
      listContainer.innerHTML = this.renderChapterList();
    }
  }

  /**
   * Scroll to current chapter in list
   */
  private scrollToCurrentChapter(): void {
    requestAnimationFrame(() => {
      const currentItem = this.container?.querySelector('.cr-chapter-item.current');
      currentItem?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
  }
}

export const chapterPicker = new ChapterPicker();
