import { ComickPageData } from '@/types';
import { findBestTitleForUrl, isEnglishTitle, hasSpecialChars } from '@/utils';
import { getFirstApplicableHint, SourceHint } from '@/sources/SourceHints';

export interface TitleComboboxHost {
  readonly pageData: ComickPageData | null;
  readonly isManualMode: boolean;
  readonly currentSourceId: string;
  escapeHtml(text: string): string;
  search(query: string): Promise<void>;
}

/**
 * TitleCombobox - Hybrid dropdown/input for selecting manga titles
 * with alternate titles, filtering, and keyboard navigation.
 */
export class TitleCombobox {
  alternateTitles: string[] = [];
  bestTitleIndex: number = 0;
  isTitleDropdownOpen: boolean = false;
  highlightedDropdownIndex: number = -1;
  blurTimeoutId: number | null = null;

  constructor(private host: TitleComboboxHost) {}

  /**
   * Reset all state for a new modal session.
   */
  reset(alternateTitles: string[]): void {
    this.alternateTitles = alternateTitles;
    this.bestTitleIndex = 0;
    this.isTitleDropdownOpen = false;
    this.highlightedDropdownIndex = -1;
    if (this.blurTimeoutId !== null) {
      clearTimeout(this.blurTimeoutId);
      this.blurTimeoutId = null;
    }
  }

  /**
   * Get the best initial title to use for searching.
   * Matches URL slug against alternate titles for best success rate.
   */
  getBestInitialTitle(): string {
    if (!this.host.pageData) return '';

    if (this.alternateTitles.length > 0) {
      const bestMatch = findBestTitleForUrl(this.host.pageData.slug, this.alternateTitles);
      if (bestMatch) {
        this.bestTitleIndex = this.alternateTitles.indexOf(bestMatch);
        return bestMatch;
      }
    }

    this.bestTitleIndex = 0;
    return this.host.pageData.title || '';
  }

  /**
   * Get titles ordered: best match first, then English titles, then non-English.
   */
  getOrderedTitles(): Array<{ title: string; index: number; isBest: boolean }> {
    const result: Array<{ title: string; index: number; isBest: boolean }> = [];

    if (this.bestTitleIndex >= 0 && this.bestTitleIndex < this.alternateTitles.length) {
      result.push({
        title: this.alternateTitles[this.bestTitleIndex],
        index: this.bestTitleIndex,
        isBest: true
      });
    }

    const englishTitles: Array<{ title: string; index: number; isBest: boolean }> = [];
    const otherTitles: Array<{ title: string; index: number; isBest: boolean }> = [];

    this.alternateTitles.forEach((title, index) => {
      if (index !== this.bestTitleIndex) {
        const entry = { title, index, isBest: false };
        if (isEnglishTitle(title)) {
          englishTitles.push(entry);
        } else {
          otherTitles.push(entry);
        }
      }
    });

    return [...result, ...englishTitles, ...otherTitles];
  }

  /**
   * Render dropdown items HTML for alternate titles.
   */
  renderTitleDropdownItems(): string {
    if (this.alternateTitles.length === 0) {
      return '<div class="cr-title-dropdown-empty">No alternate titles available</div>';
    }

    const orderedTitles = this.getOrderedTitles();

    return orderedTitles.map(({ title, index, isBest }) => `
      <div class="cr-title-dropdown-item${isBest ? ' best-match' : ''}" data-index="${index}" title="${this.host.escapeHtml(title)}">
        ${isBest ? '<span class="cr-best-star cr-icon cr-icon-star"></span>' : ''}${this.host.escapeHtml(title)}
      </div>
    `).join('');
  }

  /**
   * Wire event handlers onto the already-created DOM elements.
   * Called by the modal after createModal().
   */
  setupEventListeners(): void {
    const dropdownBtn = document.getElementById('cr-title-dropdown-btn');
    const dropdownMenu = document.getElementById('cr-title-dropdown-menu');
    const searchInput = document.getElementById('cr-match-search') as HTMLInputElement;

    dropdownBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.blurTimeoutId !== null) {
        clearTimeout(this.blurTimeoutId);
        this.blurTimeoutId = null;
      }
      this.toggleTitleDropdown();
    });

    dropdownMenu?.addEventListener('mousedown', () => {
      if (this.blurTimeoutId !== null) {
        clearTimeout(this.blurTimeoutId);
        this.blurTimeoutId = null;
      }
    });

    dropdownMenu?.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.cr-title-dropdown-item');
      if (item) {
        const index = parseInt((item as HTMLElement).dataset.index || '0');
        this.selectAlternateTitle(index);
      }
    });

    searchInput?.addEventListener('input', () => {
      this.filterTitleDropdown(searchInput.value);
      if (!this.isTitleDropdownOpen && this.alternateTitles.length > 0) {
        this.openTitleDropdown();
      }
    });

    searchInput?.addEventListener('focus', () => {
      if (this.blurTimeoutId !== null) {
        clearTimeout(this.blurTimeoutId);
        this.blurTimeoutId = null;
      }
      if (this.alternateTitles.length > 0) {
        this.filterTitleDropdown(searchInput.value);
        this.openTitleDropdown();
      }
    });

    searchInput?.addEventListener('blur', () => {
      this.blurTimeoutId = window.setTimeout(() => {
        this.blurTimeoutId = null;
        this.closeTitleDropdown();
      }, 150);
    });

    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.closeTitleDropdown();
        this.host.search((e.target as HTMLInputElement).value);
      } else if (e.key === 'Escape' && this.isTitleDropdownOpen) {
        e.stopPropagation();
        this.closeTitleDropdown();
      } else if (e.key === 'ArrowDown' && this.isTitleDropdownOpen) {
        e.preventDefault();
        this.navigateDropdown(1);
      } else if (e.key === 'ArrowUp' && this.isTitleDropdownOpen) {
        e.preventDefault();
        this.navigateDropdown(-1);
      }
    });
  }

  /**
   * Update the source hint based on current source and query.
   */
  updateSourceHint(): void {
    const hintEl = document.getElementById('cr-source-hint');
    const hintTextEl = document.getElementById('cr-hint-text');

    if (!hintEl || !hintTextEl) return;

    let hint: SourceHint | null = null;

    if (this.host.isManualMode) {
      const searchInput = document.getElementById('cr-match-search') as HTMLInputElement;
      const query = searchInput?.value || '';
      hint = getFirstApplicableHint(this.host.currentSourceId, query);
    } else {
      const anyHasSpecialChars = this.alternateTitles.some(title => hasSpecialChars(title));
      if (anyHasSpecialChars) {
        hint = getFirstApplicableHint(this.host.currentSourceId, this.alternateTitles.find(t => hasSpecialChars(t)) || '');
      }
    }

    if (hint) {
      hintTextEl.textContent = hint.message;
      hintEl.className = `cr-source-hint ${hint.type} visible`;
    } else {
      hintEl.classList.remove('visible');
    }
  }

  /**
   * Close the dropdown if it's open (used by modal for outside-click handling).
   */
  closeTitleDropdown(): void {
    const dropdownMenu = document.getElementById('cr-title-dropdown-menu');
    const dropdownBtn = document.getElementById('cr-title-dropdown-btn');

    if (dropdownMenu && dropdownBtn) {
      dropdownMenu.classList.remove('open');
      dropdownBtn.classList.remove('open');
      this.isTitleDropdownOpen = false;
      this.highlightedDropdownIndex = -1;
    }
  }

  // --- Private methods ---

  private toggleTitleDropdown(): void {
    if (this.isTitleDropdownOpen) {
      // If already showing all titles, close. Otherwise reset to show all.
      const dropdownMenu = document.getElementById('cr-title-dropdown-menu');
      const isFiltered = dropdownMenu &&
        dropdownMenu.querySelectorAll('.cr-title-dropdown-item').length < this.alternateTitles.length;
      if (isFiltered) {
        this.showAllTitles();
      } else {
        this.closeTitleDropdown();
      }
    } else {
      this.showAllTitles();
      this.openTitleDropdown();
    }
  }

  private openTitleDropdown(): void {
    const dropdownMenu = document.getElementById('cr-title-dropdown-menu');
    const dropdownBtn = document.getElementById('cr-title-dropdown-btn');

    if (dropdownMenu && dropdownBtn) {
      dropdownMenu.classList.add('open');
      dropdownBtn.classList.add('open');
      this.isTitleDropdownOpen = true;
    }
  }

  private showAllTitles(): void {
    const dropdownMenu = document.getElementById('cr-title-dropdown-menu');
    if (!dropdownMenu) return;

    dropdownMenu.innerHTML = this.renderTitleDropdownItems();
    this.highlightedDropdownIndex = -1;
  }

  private filterTitleDropdown(filter: string): void {
    const dropdownMenu = document.getElementById('cr-title-dropdown-menu');
    if (!dropdownMenu) return;

    const normalizedFilter = filter.toLowerCase().trim();

    this.updateSourceHint();

    if (this.alternateTitles.length === 0) {
      dropdownMenu.innerHTML = '<div class="cr-title-dropdown-empty">No alternate titles available</div>';
      return;
    }

    const orderedTitles = this.getOrderedTitles();
    const filteredTitles = orderedTitles.filter(({ title }) =>
      normalizedFilter === '' || title.toLowerCase().includes(normalizedFilter)
    );

    if (filteredTitles.length === 0) {
      dropdownMenu.innerHTML = '<div class="cr-title-dropdown-empty">No matches found</div>';
      return;
    }

    dropdownMenu.innerHTML = filteredTitles.map(({ title, index, isBest }) => {
      const highlightedTitle = this.highlightMatch(title, normalizedFilter);
      return `
        <div class="cr-title-dropdown-item${isBest ? ' best-match' : ''}" data-index="${index}" title="${this.host.escapeHtml(title)}">
          ${isBest ? '<span class="cr-best-star cr-icon cr-icon-star"></span>' : ''}${highlightedTitle}
        </div>
      `;
    }).join('');

    this.highlightedDropdownIndex = -1;
  }

  private highlightMatch(title: string, filter: string): string {
    if (!filter) return this.host.escapeHtml(title);

    const lowerTitle = title.toLowerCase();
    const index = lowerTitle.indexOf(filter);

    if (index === -1) return this.host.escapeHtml(title);

    const before = title.substring(0, index);
    const match = title.substring(index, index + filter.length);
    const after = title.substring(index + filter.length);

    return `${this.host.escapeHtml(before)}<mark>${this.host.escapeHtml(match)}</mark>${this.host.escapeHtml(after)}`;
  }

  private navigateDropdown(direction: number): void {
    const dropdownMenu = document.getElementById('cr-title-dropdown-menu');
    if (!dropdownMenu) return;

    const items = dropdownMenu.querySelectorAll('.cr-title-dropdown-item');
    if (items.length === 0) return;

    items.forEach(item => item.classList.remove('highlighted'));

    this.highlightedDropdownIndex += direction;
    if (this.highlightedDropdownIndex < 0) {
      this.highlightedDropdownIndex = items.length - 1;
    } else if (this.highlightedDropdownIndex >= items.length) {
      this.highlightedDropdownIndex = 0;
    }

    const targetItem = items[this.highlightedDropdownIndex] as HTMLElement;
    targetItem.classList.add('highlighted');
    targetItem.scrollIntoView({ block: 'nearest' });

    const index = parseInt(targetItem.dataset.index || '0');
    const input = document.getElementById('cr-match-search') as HTMLInputElement;
    if (input && index >= 0 && index < this.alternateTitles.length) {
      input.value = this.alternateTitles[index];
      this.updateSourceHint();
    }
  }

  private selectAlternateTitle(index: number): void {
    if (index >= 0 && index < this.alternateTitles.length) {
      const title = this.alternateTitles[index];
      const input = document.getElementById('cr-match-search') as HTMLInputElement;

      if (input) {
        input.value = title;
      }

      this.updateSourceHint();
      this.closeTitleDropdown();
      this.host.search(title);
    }
  }
}
