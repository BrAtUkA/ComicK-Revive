import { ComickPageData } from '@/types';

// Storage keys (must match core/Storage.ts)
const STORAGE_KEYS = {
  READING_STATE_PREFIX: 'reading_state_',
  SOURCE_MAPPING_PREFIX: 'source_mapping_',
};

/**
 * Simple storage helper for content script
 */
async function getFromStorage<T>(key: string): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      // Use explicit undefined check, not falsy check (to handle 0, empty objects, etc.)
      resolve(key in result ? result[key] : null);
    });
  });
}

/**
 * Check if we have reading progress for a manga
 */
async function hasReadingProgress(slug: string): Promise<boolean> {
  const key = STORAGE_KEYS.READING_STATE_PREFIX + slug;
  const state = await getFromStorage<unknown>(key);
  return state !== null;
}

/**
 * Check if we have a source mapping for a manga
 */
async function hasSourceMapping(slug: string): Promise<boolean> {
  const key = STORAGE_KEYS.SOURCE_MAPPING_PREFIX + slug;
  const mapping = await getFromStorage<unknown>(key);
  return mapping !== null;
}

/**
 * Get current chapter from reading state
 */
async function getCurrentChapter(slug: string): Promise<number | null> {
  const key = STORAGE_KEYS.READING_STATE_PREFIX + slug;
  const state = await getFromStorage<{ currentChapter?: number }>(key);
  // Use typeof check to handle chapter 0 correctly
  if (state && typeof state.currentChapter === 'number') {
    return state.currentChapter;
  }
  return null;
}

/**
 * ButtonInjector - Injects "Start Reading" / "Continue Reading" buttons into ComicK
 */
export class ButtonInjector {
  private static readonly BUTTON_ID = 'comick-revive-button';
  private static readonly BUTTON_CLASS = 'comick-revive-btn';
  private static readonly WRAPPER_CLASS = 'comick-revive-wrapper';
  private currentButton: HTMLElement | null = null;
  private injectedElements: HTMLElement[] = [];
  private onClickCallback: ((pageData: ComickPageData) => void) | null = null;

  /**
   * Set click handler
   */
  onClick(callback: (pageData: ComickPageData) => void): void {
    this.onClickCallback = callback;
  }

  /**
   * Inject button based on current page type
   */
  async inject(pageData: ComickPageData): Promise<void> {
    console.log('[ComicK Revive] Injecting button for:', pageData);
    
    // Remove all existing buttons (not just the tracked one)
    this.removeAll();

    if (pageData.pageType === 'manga') {
      await this.injectMangaPageButton(pageData);
    } else if (pageData.pageType === 'chapter') {
      await this.injectChapterPageButton(pageData);
    }
  }

  /**
   * Inject button on manga info page
   *
   * Strategy:
   * 1. If native button row exists (hydrated): inject directly alongside "Start Tracking"
   * 2. If only content column found (SSR): create wrapper, inject, then upgrade when native row appears
   * 3. Fallback: floating button
   */
  private async injectMangaPageButton(pageData: ComickPageData): Promise<void> {
    console.log('[ComicK Revive] Looking for injection point...');

    const button = await this.createMangaButton(pageData);
    const target = this.findInjectionTarget();

    if (target?.isNativeRow) {
      // Best case: native button row already exists, inject as first child
      console.log('[ComicK Revive] Found native button row, injecting alongside Start Tracking');
      target.container.insertBefore(button, target.container.firstChild);
      this.currentButton = button;
      return;
    }

    if (target) {
      // Content column found but no native buttons yet (SSR state)
      // Create a wrapper mimicking ComicK's button row structure
      console.log('[ComicK Revive] Found content column (SSR), injecting with wrapper');
      const outerWrapper = document.createElement('div');
      outerWrapper.dataset.comickReviveWrapper = 'true';
      const innerRow = document.createElement('div');
      innerRow.className = 'flex items-center w-full md:max-w-md xl:max-w-xl space-x-3';
      innerRow.appendChild(button);
      outerWrapper.appendChild(innerRow);

      target.container.insertBefore(outerWrapper, target.container.firstChild);
      this.currentButton = button;
      this.injectedElements.push(outerWrapper);

      // Watch for native buttons to appear, then merge into their row
      this.tryUpgradePosition(button, outerWrapper);
      return;
    }

    // Last resort: floating button
    console.warn('[ComicK Revive] Could not find injection point, using floating button');
    await this.createFloatingButton(pageData);
  }

  /**
   * Find the best container to inject our button into.
   * Tries multiple strategies in priority order, all scoped to `main` to avoid header matches.
   *
   * Priority:
   * A. Native button row (post-hydration): flex row with "Start Tracking"/"Follow" buttons
   * B. SSG content column: the col-span-3 div that holds Description/More Info
   *
   * After hydration, ComicK's button row structure is:
   *   <div class="col-span-3 md:col-span-2 mt-6 ...">
   *     <div>
   *       <div class="flex items-center w-full md:max-w-md xl:max-w-xl space-x-3">
   *         <button class="btn-primary">Start Tracking</button>
   *         <button>Follow</button>
   *       </div>
   *     </div>
   *     <div><h3>Description</h3>...</div>
   *   </div>
   */
  /**
   * Find ComicK's native action-button row ("Start Tracking" / "Follow") by button TEXT.
   * The Tailwind v4 / shadcn redesign removed every stable class fingerprint
   * (btn-primary, h-12.btn), but the visible labels survive restyles — text is the
   * most durable hook we have. The row renders only after React hydration, so this
   * returns null on first paint; callers fall back to the title block and
   * tryUpgradePosition() moves the button here once the row appears.
   */
  private findNativeActionRow(): HTMLElement | null {
    // Legacy class fingerprint first (pre-redesign layouts on stale CDN caches)
    const legacyBtn = document.querySelector('main button.btn-primary');
    if (legacyBtn?.parentElement) {
      return legacyBtn.parentElement as HTMLElement;
    }

    const buttons = document.querySelectorAll<HTMLButtonElement>('main button');
    // Prefer "Start Tracking" — unique to the action row. "Follow" can also appear
    // on user profiles in the comments section, so it's second choice (document
    // order means the action row near the top wins anyway).
    for (const label of ['start tracking', 'follow']) {
      for (const btn of buttons) {
        if (btn.id === ButtonInjector.BUTTON_ID) continue; // never match our own button
        if ((btn.textContent?.trim().toLowerCase() || '') === label && btn.parentElement) {
          return btn.parentElement;
        }
      }
    }
    return null;
  }

  private findInjectionTarget(): { container: HTMLElement; isNativeRow: boolean } | null {
    // Strategy A: native action row ("Start Tracking" / "Follow"), post-hydration.
    // Best placement — inserting as first child puts our button LEFT of Start Tracking.
    const nativeRow = this.findNativeActionRow();
    if (nativeRow) {
      return { container: nativeRow, isNativeRow: true };
    }

    // Strategy B: title block (new shadcn-style layout). The title block sits inside
    // the grid alongside the cover image and contains h1/h2/alt-titles/metadata/rating.
    // Temporary placement before hydration — tryUpgradePosition() relocates the button
    // into the native action row as soon as it renders.
    const titleBlock = document.querySelector(
      'main [class*="md:col-span-2"][class*="flex-col"][class*="space-y-4"]'
    ) as HTMLElement | null;
    if (titleBlock) return { container: titleBlock, isNativeRow: false };

    // Strategy B (legacy): pre-Tailwind-v4 SSG content column. Kept for users hitting
    // a stale CDN cache during the migration window.
    const col = document.querySelector(
      'main .col-span-3[class*="col-span-2"][class*="mt-6"]'
    ) as HTMLElement | null;
    if (col) return { container: col, isNativeRow: false };

    // Last resort: walk grid children for legacy col-span-3
    const grid = document.querySelector('main .grid.grid-cols-2');
    if (grid) {
      for (const child of Array.from(grid.children)) {
        const el = child as HTMLElement;
        if (el.classList?.contains('col-span-3')) {
          return { container: el, isNativeRow: false };
        }
      }
    }

    return null;
  }

  /**
   * After injecting into a temporary wrapper, watch for ComicK's native buttons
   * to appear (after React hydration). When found, move our button into the
   * native button row alongside "Start Tracking" and "Follow", then remove
   * the now-empty wrapper.
   */
  private tryUpgradePosition(button: HTMLElement, wrapper: HTMLElement): void {
    const doUpgrade = (): boolean => {
      if (!button.isConnected) return true; // button removed, stop trying

      // Text-based detection — same hook as findInjectionTarget. The old class
      // selectors (btn-primary, h-12.btn) are dead since the Tailwind v4 redesign,
      // which is why the button used to stay stuck above the title.
      const nativeRow = this.findNativeActionRow();
      if (nativeRow && button.parentElement !== nativeRow) {
        console.log('[ComicK Revive] Upgrading button position to native action row');
        nativeRow.insertBefore(button, nativeRow.firstChild);
        if (wrapper.isConnected) wrapper.remove();
        return true;
      }
      return false;
    };

    // Try immediately in case the row already exists
    if (doUpgrade()) return;

    // Poll for hydration. Text-based detection has no CSS selector to hand to
    // waitForElement's MutationObserver, and hydration completes within seconds.
    let attempts = 0;
    const maxAttempts = 20; // 10 seconds
    const poll = setInterval(() => {
      attempts++;
      if (doUpgrade() || attempts >= maxAttempts) {
        clearInterval(poll);
      }
    }, 500);
  }

  /**
   * Inject button on chapter page - inside the chapter info box
   * The box has class "rounded-md bg-gray-50 dark:bg-gray-900 p-4 max-w-md"
   */
  private async injectChapterPageButton(pageData: ComickPageData): Promise<void> {
    console.log('[ComicK Revive] Looking for chapter info box...');

    // The chapter page is React-rendered after hydration — SSR HTML is essentially
    // empty. We wait for the chapter info card to render. As of the Tailwind v4 /
    // shadcn redesign (~2025), it's identified by the unique `bg-card` class (single
    // occurrence on the page). Legacy `.rounded-md.bg-gray-50.p-4` kept as fallback
    // in case a user hits a stale CDN cache.
    const chapterInfoBox = await this.waitForElement(
      'main div[class*="bg-card"], .rounded-md.bg-gray-50.dark\\:bg-gray-900.p-4, .rounded-md[class*="bg-gray-50"][class*="p-4"]',
      5000
    );

    if (chapterInfoBox) {
      console.log('[ComicK Revive] Found chapter info box');

      // NEW layout: a vertical sections list with divide-y-2 separators between
      // sections (multilingual title list, log-in notes, rating, Back button row).
      // Insert our buttons as a new section at the top — they inherit the divider.
      const sectionsList = chapterInfoBox.querySelector(
        '[class*="divide-y-2"]'
      ) as HTMLElement | null;

      if (sectionsList) {
        const buttons = await this.createChapterButtons(pageData);
        // Wrap the buttons in a single div so they form ONE section (and get one
        // divider line below them), rather than each becoming its own divided section.
        const sectionWrapper = document.createElement('div');
        sectionWrapper.dataset.comickReviveSection = 'true';
        sectionWrapper.className = 'flex flex-col gap-2 py-3';
        for (const btn of buttons) {
          sectionWrapper.appendChild(btn);
        }
        sectionsList.insertBefore(sectionWrapper, sectionsList.firstChild);
        this.currentButton = buttons[0];
        this.injectedElements = [sectionWrapper]; // Track the wrapper for removal
        console.log('[ComicK Revive] Buttons injected into chapter sections list');
        return;
      }

      // LEGACY layout: pre-Tailwind-v4 button container
      const buttonContainer = chapterInfoBox.querySelector('.flex.flex-col.w-full.gap-2');
      if (buttonContainer) {
        const buttons = await this.createChapterButtons(pageData);
        for (let i = buttons.length - 1; i >= 0; i--) {
          buttonContainer.insertBefore(buttons[i], buttonContainer.firstChild);
        }
        this.currentButton = buttons[0];
        this.injectedElements = buttons;
        console.log('[ComicK Revive] Buttons injected into legacy chapter button container');
        return;
      }

      // Generic flex-col inside the box (broader fallback)
      const altContainer = chapterInfoBox.querySelector('.flex.flex-col');
      if (altContainer) {
        const buttons = await this.createChapterButtons(pageData);
        for (let i = buttons.length - 1; i >= 0; i--) {
          altContainer.insertBefore(buttons[i], altContainer.firstChild);
        }
        this.currentButton = buttons[0];
        this.injectedElements = buttons;
        console.log('[ComicK Revive] Buttons injected into chapter flex container');
        return;
      }
    }

    // Fallback: look for the main content area
    const mainContent = await this.waitForElement(
      'main .pl-safe, main > div:nth-child(2)',
      3000
    );

    if (mainContent) {
      const infoContainer = mainContent.querySelector('[class*="bg-card"], .rounded-md') || mainContent;

      if (infoContainer !== mainContent) {
        const flexContainer = infoContainer.querySelector('.flex.flex-col');
        if (flexContainer) {
          const buttons = await this.createChapterButtons(pageData);
          for (let i = buttons.length - 1; i >= 0; i--) {
            flexContainer.insertBefore(buttons[i], flexContainer.firstChild);
          }
          this.currentButton = buttons[0];
          this.injectedElements = buttons;
          console.log('[ComicK Revive] Buttons injected via fallback');
          return;
        }
      }
    }

    // Last resort: floating button
    console.warn('[ComicK Revive] Could not find chapter injection point');
    await this.createFloatingButton(pageData);
  }

  /**
   * Create button styled for manga info page - looks like "Start Tracking" button
   */
  private async createMangaButton(pageData: ComickPageData): Promise<HTMLElement> {
    const button = document.createElement('button');
    button.id = ButtonInjector.BUTTON_ID;
    
    // Check reading progress
    let hasProgress = false;
    let currentChapter: number | null = null;
    
    try {
      hasProgress = await hasReadingProgress(pageData.slug);
      const hasMapping = await hasSourceMapping(pageData.slug);
      console.log('[ComicK Revive] createMangaButton check:', {
        slug: pageData.slug,
        hasProgress,
        hasMapping
      });
      if (hasProgress && hasMapping) {
        currentChapter = await getCurrentChapter(pageData.slug);
        console.log('[ComicK Revive] currentChapter:', currentChapter);
      }
    } catch (e) {
      console.warn('[ComicK Revive] Could not check reading progress:', e);
    }

    // Match ComicK's "Start Tracking" button styling
    // Use w-auto instead of flex-1 so the button has consistent width
    // whether it's alone in a wrapper or inline with native buttons
    button.className = 'md:w-48 h-12 btn px-2 py-3 flex items-center justify-center rounded truncate gap-2 text-white font-medium';
    
    if (hasProgress && currentChapter !== null) {
      // Continue reading style - green like progress
      button.style.cssText = 'background: linear-gradient(135deg, #10b981 0%, #059669 100%); border: none;';
      button.innerHTML = `
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <span>Continue Ch.${currentChapter}</span>
      `;
      // forceResume — explicit "resume" intent, overrides the "Remember Reading Position" toggle
      this.attachClickHandler(button, { ...pageData, forceResume: true });
    } else {
      // Start reading style - purple/indigo to stand out
      button.style.cssText = 'background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); border: none;';
      button.innerHTML = `
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z"/>
        </svg>
        <span>Start Reading</span>
      `;
      this.attachClickHandler(button, pageData);
    }

    return button;
  }

  /**
   * Create buttons for chapter page
   * Returns array of buttons: [Continue from Ch. X] (if has progress) and [Read This Chapter]
   * Continue button is first (appears above), Read This Chapter is second (below)
   */
  private async createChapterButtons(pageData: ComickPageData): Promise<HTMLElement[]> {
    const buttons: HTMLElement[] = [];
    
    // Check reading progress
    let hasProgress = false;
    let savedChapter: number | null = null;
    
    try {
      hasProgress = await hasReadingProgress(pageData.slug);
      const hasMapping = await hasSourceMapping(pageData.slug);
      if (hasProgress && hasMapping) {
        savedChapter = await getCurrentChapter(pageData.slug);
      }
    } catch (e) {
      console.warn('[ComicK Revive] Could not check reading progress:', e);
    }

    // Button 1: "Continue Reading" - shown if user has reading progress (always, regardless of current chapter)
    // Opens the last-read chapter at the saved scroll position
    if (hasProgress && savedChapter !== null) {
      const continueBtn = this.createChapterButtonElement(
        pageData,
        savedChapter,
        'secondary'  // Green/continue style
      );
      buttons.push(continueBtn);
    }

    // Button 2: "Read This Chapter" - always shown, opens current page's chapter
    // If there's a saved position for THIS chapter, it will restore to that position
    // Use nullish coalescing (??) instead of || to allow chapter 0
    const readThisBtn = this.createChapterButtonElement(
      pageData,
      pageData.chapterNumber ?? 1,
      'primary'  // Purple/primary style
    );
    buttons.push(readThisBtn);

    return buttons;
  }

  /**
   * Create a single chapter button element
   */
  private createChapterButtonElement(
    pageData: ComickPageData,
    chapterNumber: number,
    style: 'primary' | 'secondary'
  ): HTMLElement {
    const wrapper = document.createElement('a');
    wrapper.className = `flex-1 ${ButtonInjector.WRAPPER_CLASS}`;
    wrapper.href = '#';
    wrapper.onclick = (e) => e.preventDefault();
    
    const button = document.createElement('button');
    button.type = 'button';
    
    // Match the Google search button style from ComicK
    button.className = 'h-14 overflow-hidden w-full rounded-md px-3 py-1 text-sm font-medium flex items-center cursor-pointer gap-2';
    
    const isCurrentChapter = chapterNumber === pageData.chapterNumber;
    
    if (style === 'primary') {
      // Primary: Read This Chapter - purple/indigo
      button.style.cssText = 'background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white;';
      button.innerHTML = `
        <svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z"/>
        </svg>
        <div class="text-left">
          <div class="font-bold">Read This Chapter</div>
          <div class="text-xs opacity-90">Chapter ${chapterNumber} with ComicK Revive</div>
        </div>
      `;
    } else {
      // Secondary: Continue from Ch. X - green/emerald
      button.style.cssText = 'background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white;';
      button.innerHTML = `
        <svg class="w-7 h-7 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <div class="text-left">
          <div class="font-bold">Continue Reading</div>
          <div class="text-xs opacity-90">Resume from Chapter ${chapterNumber}</div>
        </div>
      `;
    }

    // Create modified pageData with overrideChapter
    // Primary ("Read This Chapter") starts from beginning; secondary ("Continue Reading") resumes.
    // forceResume on the secondary button signals explicit "resume" intent — overrides the
    // "Remember Reading Position" master toggle if the user has it off.
    const modifiedPageData: ComickPageData = {
      ...pageData,
      overrideChapter: chapterNumber,
      ...(style === 'primary'
        ? { startFromBeginning: true }
        : { forceResume: true })
    };

    this.attachClickHandler(button, modifiedPageData);
    wrapper.appendChild(button);
    
    return wrapper;
  }

  /**
   * Attach click handler to button
   */
  private attachClickHandler(button: HTMLElement, pageData: ComickPageData): void {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('[ComicK Revive] Button clicked!');
      if (this.onClickCallback) {
        this.onClickCallback(pageData);
      }
    });
  }

  /**
   * Create a floating button as fallback
   */
  private async createFloatingButton(pageData: ComickPageData): Promise<void> {
    const button = document.createElement('button');
    button.id = ButtonInjector.BUTTON_ID;
    button.className = ButtonInjector.BUTTON_CLASS + ' floating';
    
    // Check reading progress
    let hasProgress = false;
    let currentChapter: number | null = null;
    
    try {
      hasProgress = await hasReadingProgress(pageData.slug);
      const hasMapping = await hasSourceMapping(pageData.slug);
      if (hasProgress && hasMapping) {
        currentChapter = await getCurrentChapter(pageData.slug);
      }
    } catch (e) {
      console.warn('[ComicK Revive] Could not check reading progress:', e);
    }

    if (hasProgress && currentChapter) {
      button.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <span>Continue Ch.${currentChapter}</span>
      `;
      button.classList.add('continue');
    } else {
      button.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z"/>
        </svg>
        <span>ComicK Revive</span>
      `;
    }

    this.attachClickHandler(button, pageData);
    document.body.appendChild(button);
    this.currentButton = button;
    console.log('[ComicK Revive] Floating button created');
  }

  /**
   * Wait for an element to appear in DOM
   */
  private waitForElement(selector: string, timeout: number): Promise<Element | null> {
    return new Promise((resolve) => {
      // Check if already exists
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      // Observe for changes
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      // Timeout
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  /**
   * Remove all injected buttons - comprehensive cleanup
   */
  removeAll(): void {
    // Remove all tracked elements
    for (const element of this.injectedElements) {
      try {
        element.remove();
      } catch (e) {
        // Element may already be removed
      }
    }
    this.injectedElements = [];
    
    // Remove current button reference
    if (this.currentButton) {
      try {
        // Handle wrapper case (chapter page button is wrapped in <a>)
        if (this.currentButton.tagName === 'A') {
          this.currentButton.remove();
        } else {
          this.currentButton.remove();
        }
      } catch (e) {
        // Element may already be removed
      }
      this.currentButton = null;
    }

    // Also clean up by ID in case reference was lost
    const existingById = document.getElementById(ButtonInjector.BUTTON_ID);
    if (existingById) {
      // Check if parent is our wrapper
      if (existingById.parentElement?.tagName === 'A' && existingById.parentElement.classList.contains(ButtonInjector.WRAPPER_CLASS)) {
        existingById.parentElement.remove();
      } else {
        existingById.remove();
      }
    }
    
    // Clean up all elements by wrapper class (catches any stragglers)
    const wrapperElements = document.querySelectorAll(`.${ButtonInjector.WRAPPER_CLASS}`);
    wrapperElements.forEach(el => el.remove());

    // Clean up our content column wrapper divs
    const reviveWrappers = document.querySelectorAll('[data-comick-revive-wrapper]');
    reviveWrappers.forEach(el => el.remove());
  }

  /**
   * Remove injected button (alias for removeAll for backwards compatibility)
   */
  remove(): void {
    this.removeAll();
  }

  /**
   * Show loading state on the button
   */
  showLoading(message: string = 'Loading...'): void {
    if (this.currentButton) {
      // Store original text
      this.currentButton.dataset.originalText = this.currentButton.textContent || '';
      this.currentButton.textContent = message;
      this.currentButton.classList.add('loading');
      (this.currentButton as HTMLButtonElement).disabled = true;
    }
  }

  /**
   * Hide loading state and restore button
   */
  hideLoading(): void {
    if (this.currentButton) {
      const originalText = this.currentButton.dataset.originalText;
      if (originalText) {
        this.currentButton.textContent = originalText;
        delete this.currentButton.dataset.originalText;
      }
      this.currentButton.classList.remove('loading');
      (this.currentButton as HTMLButtonElement).disabled = false;
    }
  }

  /**
   * Update button state
   */
  async update(pageData: ComickPageData): Promise<void> {
    if (this.currentButton) {
      await this.inject(pageData);
    }
  }
}
