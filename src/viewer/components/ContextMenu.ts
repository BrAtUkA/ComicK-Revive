import { SearchResult } from '@/types';

export interface ContextMenuHost {
  readonly currentSourceId: string;
  getSearchResults(): SearchResult[];
  showDetailsPanel(result: SearchResult): Promise<void>;
}

/**
 * ContextMenu - Custom right-click context menu for search result items.
 * Supports both list (.cr-result-item) and grid (.cr-grid-card) items via event delegation.
 */
export class ContextMenu {
  private contextMenu: HTMLElement | null = null;
  private contextMenuCloseHandler: ((e: Event) => void) | null = null;
  private contextMenuTarget: HTMLElement | null = null;
  private contextMenuTargetHandler: ((e: Event) => void) | null = null;

  constructor(private host: ContextMenuHost) {}

  /**
   * Attach context menu handlers to result items (event delegation).
   */
  attachContextMenuHandlers(container: HTMLElement): void {
    // Remove previous handler to prevent stacking on re-renders
    if (this.contextMenuTarget && this.contextMenuTargetHandler) {
      this.contextMenuTarget.removeEventListener('contextmenu', this.contextMenuTargetHandler);
    }

    this.contextMenuTarget = container;
    this.contextMenuTargetHandler = (e: Event) => {
      const me = e as MouseEvent;
      const item = (me.target as HTMLElement).closest('.cr-result-item, .cr-grid-card') as HTMLElement;
      if (!item) return;
      me.preventDefault();

      let result: SearchResult | undefined;
      // Unified slug+sourceId lookup for both list items and grid cards
      const slug = item.dataset.slug;
      const sid = item.dataset.sourceId;
      if (slug && sid) {
        result = this.host.getSearchResults().find(
          r => r.slug === slug && (r.sourceId || this.host.currentSourceId) === sid
        );
      }
      if (!result) return;

      this.showContextMenu(me.clientX, me.clientY, result);
    };

    container.addEventListener('contextmenu', this.contextMenuTargetHandler);
  }

  /**
   * Show custom context menu at (x, y) for a search result.
   */
  showContextMenu(x: number, y: number, result: SearchResult): void {
    this.hideContextMenu();

    this.contextMenu = document.createElement('div');
    this.contextMenu.className = 'cr-context-menu';
    this.contextMenu.innerHTML = `
      <button class="cr-context-menu-item" data-action="details">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
        </svg>
        <span>Details</span>
      </button>
    `;

    // Position with viewport boundary checks
    const menuWidth = 150;
    const menuHeight = 44;
    const finalX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
    const finalY = y + menuHeight > window.innerHeight ? y - menuHeight : y;
    this.contextMenu.style.left = `${finalX}px`;
    this.contextMenu.style.top = `${finalY}px`;

    document.body.appendChild(this.contextMenu);

    this.contextMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const menuItem = (e.target as HTMLElement).closest('.cr-context-menu-item') as HTMLElement;
      if (!menuItem) return;

      if (menuItem.dataset.action === 'details') {
        this.host.showDetailsPanel(result);
      }
      this.hideContextMenu();
    });

    // Close on any outside click (next tick to avoid immediate close)
    requestAnimationFrame(() => {
      // Clean up any previous handler first (prevents leaks from rapid re-calls)
      if (this.contextMenuCloseHandler) {
        document.removeEventListener('click', this.contextMenuCloseHandler);
        document.removeEventListener('contextmenu', this.contextMenuCloseHandler);
      }
      this.contextMenuCloseHandler = () => {
        this.hideContextMenu();
      };
      document.addEventListener('click', this.contextMenuCloseHandler);
      document.addEventListener('contextmenu', this.contextMenuCloseHandler);
    });
  }

  hideContextMenu(): void {
    if (this.contextMenuCloseHandler) {
      document.removeEventListener('click', this.contextMenuCloseHandler);
      document.removeEventListener('contextmenu', this.contextMenuCloseHandler);
      this.contextMenuCloseHandler = null;
    }
    this.contextMenu?.remove();
    this.contextMenu = null;
  }

  /**
   * Clean up all state and event handlers.
   */
  cleanup(): void {
    this.hideContextMenu();
    if (this.contextMenuTarget && this.contextMenuTargetHandler) {
      this.contextMenuTarget.removeEventListener('contextmenu', this.contextMenuTargetHandler);
    }
    this.contextMenuTarget = null;
    this.contextMenuTargetHandler = null;
  }
}
