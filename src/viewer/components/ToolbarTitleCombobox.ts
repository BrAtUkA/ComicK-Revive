/**
 * ToolbarTitleCombobox - Compact hybrid dropdown/text field for the viewer toolbar.
 * Allows picking from alternate titles or typing a custom one.
 */
export class ToolbarTitleCombobox {
  private parentElement: HTMLElement | null = null;
  private displaySpan: HTMLElement | null = null;
  private editContainer: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private dropdownMenu: HTMLElement | null = null;
  private dropdownBtn: HTMLButtonElement | null = null;

  private isActive: boolean = false;
  private isDropdownOpen: boolean = false;
  private highlightedIndex: number = -1;
  private blurTimeoutId: number | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private activateWidth: number = 0;
  // Guards against blur firing during activate transition
  private isActivating: boolean = false;

  private currentTitle: string = 'Unknown';
  private originalTitle: string = '';
  private alternateTitles: string[] = [];

  private onSave: ((customTitle: string | null) => Promise<void>) | null = null;
  private onKeyboardDisable: (() => void) | null = null;
  private onKeyboardRestore: (() => void) | null = null;

  // --- Lifecycle ---

  mount(parent: HTMLElement): void {
    this.parentElement = parent;
    this.createDisplaySpan();
  }

  unmount(): void {
    if (this.isActive) {
      this.deactivate(true);
    }
    if (this.blurTimeoutId !== null) {
      clearTimeout(this.blurTimeoutId);
      this.blurTimeoutId = null;
    }
    this.parentElement = null;
    this.displaySpan = null;
  }

  // --- Data ---

  setTitles(options: {
    displayTitle: string;
    originalTitle: string;
    alternateTitles: string[];
  }): void {
    this.currentTitle = options.displayTitle;
    this.originalTitle = options.originalTitle;

    // Deduplicate: ensure originalTitle is in the list, remove dupes
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const t of options.alternateTitles) {
      const trimmed = t.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        deduped.push(trimmed);
      }
    }
    if (this.originalTitle && !seen.has(this.originalTitle)) {
      deduped.unshift(this.originalTitle);
    }
    this.alternateTitles = deduped;

    // Update display if not in edit mode
    if (this.displaySpan && !this.isActive) {
      this.displaySpan.textContent = this.currentTitle;
      this.displaySpan.title = this.currentTitle;
    }
  }

  updateDisplayTitle(title: string): void {
    this.currentTitle = title;
    if (this.displaySpan && !this.isActive) {
      this.displaySpan.textContent = title;
      this.displaySpan.title = title;
    }
  }

  // --- Callbacks ---

  setCallbacks(callbacks: {
    onSave: (customTitle: string | null) => Promise<void>;
    onKeyboardDisable: () => void;
    onKeyboardRestore: () => void;
  }): void {
    this.onSave = callbacks.onSave;
    this.onKeyboardDisable = callbacks.onKeyboardDisable;
    this.onKeyboardRestore = callbacks.onKeyboardRestore;
  }

  // --- Display span ---

  private createDisplaySpan(): void {
    this.displaySpan = document.createElement('span');
    this.displaySpan.className = 'cr-manga-title';
    this.displaySpan.id = 'cr-manga-title';
    this.displaySpan.textContent = this.currentTitle;
    this.displaySpan.title = this.currentTitle;
    this.displaySpan.addEventListener('click', this.handleSpanClick);
    this.parentElement?.appendChild(this.displaySpan);
  }

  private handleSpanClick = (): void => {
    this.activate();
  };

  // --- Activate / Deactivate ---

  private activate(): void {
    if (this.isActive || !this.parentElement) return;
    this.isActive = true;
    this.isActivating = true;

    // Measure span width before removing it so input matches
    this.activateWidth = this.displaySpan
      ? Math.max(this.displaySpan.offsetWidth, 120)
      : 250;

    // Remove display span
    this.displaySpan?.remove();

    // Create edit container
    this.editContainer = document.createElement('div');
    this.editContainer.className = 'cr-toolbar-title-edit';

    // Input — match the measured span width
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'cr-toolbar-title-input';
    this.input.value = this.currentTitle;
    this.input.placeholder = this.originalTitle || 'Enter title...';
    this.input.style.width = `${this.activateWidth}px`;
    this.editContainer.appendChild(this.input);

    // Dropdown button (only if there are titles to show)
    if (this.alternateTitles.length > 0) {
      this.dropdownBtn = document.createElement('button');
      this.dropdownBtn.className = 'cr-toolbar-title-dropdown-btn';
      this.dropdownBtn.title = 'Show alternate titles';
      this.dropdownBtn.type = 'button';
      this.dropdownBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M7 10l5 5 5-5z"/></svg>';
      this.editContainer.appendChild(this.dropdownBtn);
    }

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'cr-toolbar-title-reset-btn';
    resetBtn.title = 'Reset to original title';
    resetBtn.type = 'button';
    resetBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';
    this.editContainer.appendChild(resetBtn);

    // Dropdown menu
    this.dropdownMenu = document.createElement('div');
    this.dropdownMenu.className = 'cr-toolbar-title-dropdown';
    this.editContainer.appendChild(this.dropdownMenu);

    this.parentElement.appendChild(this.editContainer);

    // --- Wire events ---

    // Input events
    this.input.addEventListener('keydown', this.handleKeydown);
    this.input.addEventListener('input', this.handleInput);
    this.input.addEventListener('blur', this.handleBlur);

    // Single mousedown on the entire editContainer cancels blur.
    // This catches: dropdown items, scrollbar, dropdown button, reset button —
    // all in one handler, making the dropdown robust against scrollbar dismissal.
    this.editContainer.addEventListener('mousedown', this.handleContainerMousedown);

    // Click handlers for interactive children
    this.dropdownBtn?.addEventListener('click', this.handleDropdownBtnClick);
    this.dropdownMenu.addEventListener('click', this.handleDropdownClick);
    resetBtn.addEventListener('click', this.handleResetClick);

    // Outside click to save+close — registered on next frame so the
    // activating click itself doesn't immediately trigger it.
    this.outsideClickHandler = (e: MouseEvent) => {
      if (this.editContainer && !this.editContainer.contains(e.target as Node)) {
        this.save();
      }
    };
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', this.outsideClickHandler!);
      // Clear the activation guard after the first frame
      this.isActivating = false;
    });

    // Disable viewer keyboard shortcuts
    this.onKeyboardDisable?.();

    // Focus and select — defer to next microtask so the browser has
    // fully laid out the input, preventing a stale-focus blur race.
    Promise.resolve().then(() => {
      if (this.input) {
        this.input.focus();
        this.input.select();
      }
    });

    // Open dropdown if titles exist — show all (no filter on open)
    if (this.alternateTitles.length > 0) {
      this.renderDropdownItems();
      this.openDropdown();
    }
  }

  private deactivate(skipRestore: boolean = false): void {
    if (!this.isActive || !this.parentElement) return;
    this.isActive = false;

    // Clean up blur timeout
    if (this.blurTimeoutId !== null) {
      clearTimeout(this.blurTimeoutId);
      this.blurTimeoutId = null;
    }

    // Remove outside click handler
    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }

    // Remove edit container
    this.editContainer?.remove();
    this.editContainer = null;
    this.input = null;
    this.dropdownMenu = null;
    this.dropdownBtn = null;
    this.isDropdownOpen = false;
    this.highlightedIndex = -1;

    // Re-create display span
    this.createDisplaySpan();

    // Re-enable keyboard
    if (!skipRestore) {
      this.onKeyboardRestore?.();
    }
  }

  // --- Save / Cancel ---

  private save(): void {
    if (!this.input) return;
    const newTitle = this.input.value.trim();

    if (newTitle && newTitle !== this.originalTitle) {
      this.currentTitle = newTitle;
      this.onSave?.(newTitle);
    } else {
      this.currentTitle = this.originalTitle;
      this.onSave?.(null);
    }

    this.deactivate();
  }

  private cancel(): void {
    this.deactivate();
  }

  // --- Dropdown ---

  private openDropdown(): void {
    if (!this.dropdownMenu) return;
    this.dropdownMenu.classList.add('open');
    this.dropdownBtn?.classList.add('open');
    this.isDropdownOpen = true;
  }

  private closeDropdown(): void {
    if (!this.dropdownMenu) return;
    this.dropdownMenu.classList.remove('open');
    this.dropdownBtn?.classList.remove('open');
    this.isDropdownOpen = false;
    this.highlightedIndex = -1;
  }

  private renderDropdownItems(filter: string = ''): void {
    if (!this.dropdownMenu) return;

    const normalizedFilter = filter.toLowerCase().trim();
    const currentInputValue = this.input?.value.trim() || '';

    const filtered = normalizedFilter
      ? this.alternateTitles.filter(t => t.toLowerCase().includes(normalizedFilter))
      : this.alternateTitles;

    if (filtered.length === 0) {
      this.dropdownMenu.innerHTML = '<div class="cr-toolbar-title-dropdown-empty">No matches</div>';
      this.highlightedIndex = -1;
      return;
    }

    this.dropdownMenu.innerHTML = '';
    for (const title of filtered) {
      const item = document.createElement('div');
      item.className = 'cr-toolbar-title-dropdown-item';
      if (title === currentInputValue) {
        item.classList.add('selected');
      }
      item.dataset.title = title;
      item.title = title;

      if (normalizedFilter) {
        const lowerTitle = title.toLowerCase();
        const matchIndex = lowerTitle.indexOf(normalizedFilter);
        if (matchIndex >= 0) {
          const before = title.substring(0, matchIndex);
          const match = title.substring(matchIndex, matchIndex + normalizedFilter.length);
          const after = title.substring(matchIndex + normalizedFilter.length);
          item.innerHTML = this.escapeHtml(before) + '<mark>' + this.escapeHtml(match) + '</mark>' + this.escapeHtml(after);
        } else {
          item.textContent = title;
        }
      } else {
        item.textContent = title;
      }

      this.dropdownMenu.appendChild(item);
    }

    this.highlightedIndex = -1;
  }

  private navigateDropdown(direction: number): void {
    if (!this.dropdownMenu) return;

    const items = this.dropdownMenu.querySelectorAll('.cr-toolbar-title-dropdown-item');
    if (items.length === 0) return;

    items.forEach(item => item.classList.remove('highlighted'));

    this.highlightedIndex += direction;
    if (this.highlightedIndex < 0) {
      this.highlightedIndex = items.length - 1;
    } else if (this.highlightedIndex >= items.length) {
      this.highlightedIndex = 0;
    }

    const target = items[this.highlightedIndex] as HTMLElement;
    target.classList.add('highlighted');
    target.scrollIntoView({ block: 'nearest' });

    if (this.input && target.dataset.title) {
      this.input.value = target.dataset.title;
    }
  }

  private selectItem(title: string): void {
    if (!this.input) return;
    this.input.value = title;
    this.closeDropdown();
    this.save();
  }

  // --- Event handlers ---

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.isDropdownOpen && this.highlightedIndex >= 0) {
        const items = this.dropdownMenu?.querySelectorAll('.cr-toolbar-title-dropdown-item');
        const target = items?.[this.highlightedIndex] as HTMLElement | undefined;
        if (target?.dataset.title) {
          this.selectItem(target.dataset.title);
          return;
        }
      }
      this.save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.isDropdownOpen) {
        this.closeDropdown();
      } else {
        this.cancel();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.isDropdownOpen && this.alternateTitles.length > 0) {
        this.renderDropdownItems();
        this.openDropdown();
      }
      this.navigateDropdown(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.isDropdownOpen && this.alternateTitles.length > 0) {
        this.renderDropdownItems();
        this.openDropdown();
      }
      this.navigateDropdown(-1);
    }
  };

  private handleInput = (): void => {
    if (!this.input) return;
    this.renderDropdownItems(this.input.value);
    if (!this.isDropdownOpen && this.alternateTitles.length > 0) {
      this.openDropdown();
    }
  };

  /**
   * Blur handler — save after a short delay.
   * The delay lets mousedown on container children cancel via handleContainerMousedown.
   * The isActivating guard prevents blur from firing during the activate() transition.
   */
  private handleBlur = (): void => {
    if (this.isActivating) return;
    this.blurTimeoutId = window.setTimeout(() => {
      this.blurTimeoutId = null;
      this.save();
    }, 200);
  };

  /**
   * Single mousedown handler on the entire editContainer.
   * Cancels any pending blur so that clicking the dropdown, its scrollbar,
   * the chevron button, or the reset button doesn't dismiss the combobox.
   */
  private handleContainerMousedown = (e: MouseEvent): void => {
    // Cancel pending blur
    if (this.blurTimeoutId !== null) {
      clearTimeout(this.blurTimeoutId);
      this.blurTimeoutId = null;
    }
    // If the click was NOT on the input, prevent default to stop the browser
    // from moving focus away from the input (which would re-trigger blur).
    // This is the key fix for scrollbar interaction.
    if (e.target !== this.input) {
      e.preventDefault();
    }
  };

  // Arrow button always shows ALL options (resets any filter)
  private handleDropdownBtnClick = (e: Event): void => {
    e.stopPropagation();
    this.renderDropdownItems();
    if (!this.isDropdownOpen) {
      this.openDropdown();
    }
    this.input?.focus();
  };

  private handleDropdownClick = (e: Event): void => {
    const item = (e.target as HTMLElement).closest('.cr-toolbar-title-dropdown-item') as HTMLElement | null;
    if (item?.dataset.title) {
      this.selectItem(item.dataset.title);
    }
  };

  private handleResetClick = (e: Event): void => {
    e.preventDefault();
    if (this.input) {
      this.input.value = this.originalTitle;
      this.input.focus();
      this.input.select();
      this.renderDropdownItems();
    }
  };

  // --- Utility ---

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
