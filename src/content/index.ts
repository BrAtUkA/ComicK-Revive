import { ComickParser } from './comick-parser';
import { ButtonInjector } from './injector';
import { ComickPageData } from '@/types';
import { extractAlternateTitlesFromHtml } from '@/shared/comick-html-parser';
import './styles.css';  // Import styles to be bundled

/**
 * ComicK Revive - Content Script
 * 
 * This script runs on ComicK pages and:
 * 1. Detects manga/chapter pages
 * 2. Injects "Start Reading" / "Continue Reading" buttons
 * 3. Opens the viewer overlay when clicked
 */
class ContentScript {
  private injector: ButtonInjector;
  private currentPageData: ComickPageData | null = null;
  private cleanupNavObserver: (() => void) | null = null;
  private navTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.injector = new ButtonInjector();
    this.injector.onClick(this.handleButtonClick.bind(this));
  }

  /**
   * Initialize the content script
   */
  async init(): Promise<void> {
    console.log('[ComicK Revive] Content script initializing...');

    // Setup message bridge EARLY - before any viewer loads
    this.setupMessageBridge();

    // Wait for page to be ready
    await ComickParser.waitForReady().catch(() => {
      console.warn('[ComicK Revive] Page load timeout, continuing anyway');
    });

    // Parse current page
    this.currentPageData = ComickParser.parse();

    if (this.currentPageData) {
      console.log('[ComicK Revive] Detected page:', this.currentPageData);
      await this.injector.inject(this.currentPageData);
    }

    // Observe for SPA navigation
    this.cleanupNavObserver = ComickParser.observeNavigation(
      this.handleNavigation.bind(this)
    );

    this.maybeHandleDeepLink();
  }

  /**
   * Deep link from the dashboard/popup: /comic/{slug}?crv_resume=1 auto-opens
   * the reader at the saved position (same semantics as the "Continue
   * Reading" button). The param is stripped so a plain refresh doesn't
   * reopen the reader.
   */
  private maybeHandleDeepLink(): void {
    const params = new URLSearchParams(window.location.search);
    if (params.get('crv_resume') !== '1') return;

    params.delete('crv_resume');
    const query = params.toString();
    history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);

    if (this.currentPageData?.pageType !== 'manga') return;

    // Wait for the page to fully load before opening. Auto-opening while
    // ComicK is still hydrating can leave the underlying page scrollable
    // behind the reader (light scrollbars showing as white strips at the
    // edges). A manual button click never hits this because the user clicks
    // after the page has settled.
    const openWhenSettled = () => {
      setTimeout(() => {
        if (this.currentPageData?.pageType === 'manga') {
          console.log('[ComicK Revive] Deep link detected, auto-opening reader');
          void this.handleButtonClick({ ...this.currentPageData, forceResume: true });
        }
      }, 600);
    };
    if (document.readyState === 'complete') {
      openWhenSettled();
    } else {
      window.addEventListener('load', openWhenSettled, { once: true });
    }
  }

  /**
   * Handle SPA navigation
   */
  private async handleNavigation(pageData: ComickPageData | null): Promise<void> {
    console.log('[ComicK Revive] Navigation detected:', pageData);

    this.currentPageData = pageData;

    // Cancel any pending injection from a previous navigation
    if (this.navTimeoutId !== null) {
      clearTimeout(this.navTimeoutId);
      this.navTimeoutId = null;
    }

    if (pageData) {
      // Small delay to let ComicK's DOM settle
      this.navTimeoutId = setTimeout(async () => {
        this.navTimeoutId = null;
        await this.injector.inject(pageData);
      }, 500);
    } else {
      this.injector.remove();
    }
  }

  /**
   * Handle button click - open viewer
   * For chapter pages with limited titles, fetch manga info first for better search results
   */
  private async handleButtonClick(pageData: ComickPageData): Promise<void> {
    console.log('[ComicK Revive] Button clicked, opening viewer for:', pageData);

    // Orphaned-context guard: when the extension is reloaded/updated while this tab
    // stays open, the injected content script keeps running but loses all chrome.*
    // APIs (chrome.runtime becomes undefined → "Cannot read properties of undefined
    // (reading 'getURL')"). Nothing works until the page is refreshed, so detect it
    // up front and tell the user instead of crashing cryptically.
    if (!chrome.runtime?.id) {
      alert('ComicK Revive was updated or reloaded. Please refresh the page and try again.');
      return;
    }

    // Always fetch fresh titles from the manga info page.
    // SPA navigation can leave stale __NEXT_DATA__ / DOM elements,
    // so re-parsing the live DOM is unreliable. A fresh HTTP fetch
    // of /comic/{slug} guarantees current alternate titles.
    this.injector.showLoading('Fetching manga info...');

    // Keep the fetch try/catch separate from openViewer: previously a viewer error
    // was caught here, mislabeled "Failed to fetch manga info", and openViewer was
    // invoked a second time in the fallback — crashing twice.
    let enrichedData = pageData;
    try {
      enrichedData = await this.fetchMangaInfoTitles(pageData);
    } catch (error) {
      console.error('[ComicK Revive] Failed to fetch manga info:', error);
      // Fallback: try DOM re-parse, then keep closure data
      const freshPageData = ComickParser.parse();
      if (freshPageData && freshPageData.slug === pageData.slug) {
        enrichedData = freshPageData;
      }
    } finally {
      this.injector.hideLoading();
    }

    this.openViewer(enrichedData);
  }

  /**
   * Fetch alternate titles from manga info page
   */
  private async fetchMangaInfoTitles(pageData: ComickPageData): Promise<ComickPageData> {
    try {
      const mangaInfoUrl = `${window.location.origin}/comic/${pageData.slug}`;
      console.log('[ComicK Revive] Fetching manga info from:', mangaInfoUrl);
      
      const response = await fetch(mangaInfoUrl);
      if (!response.ok) {
        console.warn('[ComicK Revive] Failed to fetch manga info page:', response.status);
        return pageData;
      }
      
      const html = await response.text();
      const fetchedTitles = extractAlternateTitlesFromHtml(html);
      console.log('[ComicK Revive] Extracted titles:', fetchedTitles);
      
      if (fetchedTitles.length > 0) {
        // For chapter pages, we're replacing the placeholder data entirely
        // Find the best English title for display
        const englishTitle = fetchedTitles.find(t => /^[a-zA-Z0-9\s\-'":!?.,()]+$/.test(t));
        const newTitle = englishTitle || fetchedTitles[0];
        
        return {
          ...pageData,
          title: newTitle,
          alternateTitles: fetchedTitles,  // Use all fetched titles
        };
      }
      
      return pageData;
    } catch (error) {
      console.error('[ComicK Revive] Error fetching manga info:', error);
      return pageData;
    }
  }

  /**
   * Open the manga viewer overlay
   * Injects the viewer script dynamically
   */
  private openViewer(pageData: ComickPageData): void {
    // Orphaned-context guard (see handleButtonClick). chrome.runtime is undefined
    // after the extension is reloaded while this page stays open; getURL below
    // would throw a cryptic TypeError. A page refresh is the only recovery.
    if (!chrome.runtime?.id) {
      alert('ComicK Revive was updated or reloaded. Please refresh the page and try again.');
      return;
    }

    // Store page data for the viewer to pick up
    (window as any).__comickRevivePageData = pageData;

    console.log('[ComicK Revive] openViewer with startFromBeginning:', pageData.startFromBeginning, 'overrideChapter:', pageData.overrideChapter);
    
    // Listen for viewer close event to re-inject buttons with updated progress
    const closeHandler = async () => {
      console.log('[ComicK Revive] Viewer closed, re-injecting buttons');
      window.removeEventListener('comick-revive-close', closeHandler);
      // Re-inject buttons with updated reading progress
      if (this.currentPageData) {
        await this.injector.inject(this.currentPageData);
      }
    };
    window.addEventListener('comick-revive-close', closeHandler);
    
    // Check if viewer script is already loaded
    if (document.getElementById('comick-revive-viewer-script')) {
      // Viewer already loaded, just dispatch event to open
      window.dispatchEvent(new CustomEvent('comick-revive-open', { detail: pageData }));
      return;
    }
    
    // Inject viewer styles first
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('assets/style.css');
    document.head.appendChild(link);
    
    // Inject viewer script
    const script = document.createElement('script');
    script.id = 'comick-revive-viewer-script';
    script.src = chrome.runtime.getURL('viewer.js');
    script.type = 'module';
    script.onload = () => {
      console.log('[ComicK Revive] Viewer script loaded');
      // Give it a moment to initialize, then dispatch open event
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('comick-revive-open', { detail: pageData }));
      }, 100);
    };
    script.onerror = (err) => {
      console.error('[ComicK Revive] Failed to load viewer script:', err);
      alert('Failed to load ComicK Revive viewer. Please refresh the page and try again.');
    };
    document.head.appendChild(script);
  }
  
  /**
   * Setup message bridge between page script (viewer) and extension context
   * The viewer runs in page context and can't access chrome.* APIs directly
   * Uses window.postMessage() which works across the boundary
   */
  private setupMessageBridge(): void {
    if ((window as any).__comickReviveBridgeSetup) return;
    (window as any).__comickReviveBridgeSetup = true;
    
    console.log('[ComicK Revive] Setting up message bridge');
    
    // Listen for messages from the viewer (page context) via postMessage
    window.addEventListener('message', async (event: MessageEvent) => {
      // Only accept messages from same window
      if (event.source !== window) return;
      
      // Check if it's our bridge message
      if (event.data?.type !== 'COMICK_REVIVE_BRIDGE') return;
      
      const { id, action, payload } = event.data;
      
      console.log('[ComicK Revive Bridge] Received:', action, payload);
      
      try {
        let result: any;
        
        switch (action) {
          case 'STORAGE_GET':
            result = await new Promise((resolve) => {
              chrome.storage.local.get(payload.key, (data) => {
                resolve(data[payload.key] ?? payload.defaultValue);
              });
            });
            break;
            
          case 'STORAGE_SET':
            await new Promise<void>((resolve) => {
              chrome.storage.local.set({ [payload.key]: payload.value }, () => resolve());
            });
            result = true;
            break;
            
          case 'STORAGE_REMOVE':
            await new Promise<void>((resolve) => {
              chrome.storage.local.remove(payload.key, () => resolve());
            });
            result = true;
            break;
            
          case 'STORAGE_GET_ALL':
            result = await new Promise((resolve) => {
              chrome.storage.local.get(null, (data) => resolve(data));
            });
            break;
            
          case 'FETCH':
            // Send fetch request to background script
            result = await chrome.runtime.sendMessage({
              type: 'FETCH',
              payload: payload
            });
            break;
            
          default:
            // Forward to background script
            result = await chrome.runtime.sendMessage({ type: action, payload });
        }
        
        console.log('[ComicK Revive Bridge] Sending response:', action, 'id:', id, 'result:', typeof result === 'object' ? JSON.stringify(result).substring(0, 100) : result);
        
        // Send response back to viewer via postMessage
        window.postMessage({
          type: 'COMICK_REVIVE_BRIDGE_RESPONSE',
          id,
          success: true,
          result
        }, '*');
        
      } catch (error) {
        console.error('[ComicK Revive Bridge] Error:', error);
        window.postMessage({
          type: 'COMICK_REVIVE_BRIDGE_RESPONSE',
          id,
          success: false,
          error: String(error)
        }, '*');
      }
    });
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.cleanupNavObserver) {
      this.cleanupNavObserver();
    }
    this.injector.remove();
  }
}

// Initialize
const contentScript = new ContentScript();
contentScript.init().catch(console.error);

// Expose for debugging
(window as unknown as { comickRevive: ContentScript }).comickRevive = contentScript;
