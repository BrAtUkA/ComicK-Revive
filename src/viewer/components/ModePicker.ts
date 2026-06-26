import { ReadingMode, ImageFit } from '@/types';

/**
 * ModePicker - Dropdown for selecting reading mode and fit options
 */
export class ModePicker {
  private container: HTMLElement | null = null;
  private currentMode: ReadingMode = 'vertical';
  private currentFit: ImageFit = 'width';
  private isOpen: boolean = false;
  
  private onModeChange?: (mode: ReadingMode) => void;
  private onFitChange?: (fit: ImageFit) => void;
  private onClose?: () => void;

  /**
   * Show the mode picker dropdown
   */
  show(
    anchorElement: HTMLElement,
    currentMode: ReadingMode,
    currentFit: ImageFit,
    onModeChange: (mode: ReadingMode) => void,
    onFitChange: (fit: ImageFit) => void,
    onClose?: () => void
  ): void {
    // If already open, close it (toggle behavior)
    if (this.isOpen) {
      this.hide();
      return;
    }

    this.currentMode = currentMode;
    this.currentFit = currentFit;
    this.onModeChange = onModeChange;
    this.onFitChange = onFitChange;
    this.onClose = onClose;

    this.createDropdown(anchorElement);
    this.isOpen = true;
  }

  /**
   * Hide the picker
   */
  hide(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    this.isOpen = false;
    document.removeEventListener('click', this.handleOutsideClick, true);
    document.removeEventListener('keydown', this.handleKeydown);
  }

  /**
   * Create dropdown DOM
   */
  private createDropdown(anchor: HTMLElement): void {
    // Clean up any existing dropdown
    document.getElementById('cr-mode-picker')?.remove();

    const rect = anchor.getBoundingClientRect();

    this.container = document.createElement('div');
    this.container.id = 'cr-mode-picker';
    this.container.className = 'cr-dropdown';
    
    // Position dropdown below anchor, aligned to right edge
    const dropdownWidth = 180;
    let leftPos = rect.right - dropdownWidth;
    
    // Make sure it doesn't go off-screen to the left
    if (leftPos < 10) {
      leftPos = rect.left;
    }
    
    this.container.style.top = `${rect.bottom + 8}px`;
    this.container.style.left = `${leftPos}px`;
    
    this.container.innerHTML = `
      <div class="cr-dropdown-section">
        <div class="cr-dropdown-label">Reading Mode</div>
        <div class="cr-dropdown-options">
          ${this.renderModeOption('vertical', 'Vertical Scroll', 'M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z')}
          ${this.renderModeOption('single', 'Single Page', 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z')}
          ${this.renderModeOption('double', 'Double Page', 'M3 5v14h8V5H3zm10 0v14h8V5h-8z')}
        </div>
      </div>
      
      <div class="cr-dropdown-divider"></div>
      
      <div class="cr-dropdown-section">
        <div class="cr-dropdown-label">Image Fit</div>
        <div class="cr-dropdown-options">
          ${this.renderFitOption('width', 'Fit Width')}
          ${/* TODO: Fix height and contain fit modes - they don't work correctly
          this.renderFitOption('height', 'Fit Height')}
          ${this.renderFitOption('contain', 'Contain')
          */ ''}
          ${this.renderFitOption('original', 'Original Size')}
        </div>
      </div>
    `;

    document.body.appendChild(this.container);
    this.setupEventListeners();
  }

  /**
   * Render mode option
   */
  private renderModeOption(mode: ReadingMode, label: string, iconPath: string): string {
    const isActive = mode === this.currentMode;
    return `
      <button class="cr-dropdown-option ${isActive ? 'active' : ''}" data-mode="${mode}">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
          <path d="${iconPath}"/>
        </svg>
        <span>${label}</span>
      </button>
    `;
  }

  /**
   * Render fit option
   */
  private renderFitOption(fit: ImageFit, label: string): string {
    const isActive = fit === this.currentFit;
    return `
      <button class="cr-dropdown-option ${isActive ? 'active' : ''}" data-fit="${fit}">
        <span>${label}</span>
      </button>
    `;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Mode options
    this.container?.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = (e.currentTarget as HTMLElement).dataset.mode as ReadingMode;
        this.onModeChange?.(mode);
        this.hide();
      });
    });

    // Fit options
    this.container?.querySelectorAll('[data-fit]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fit = (e.currentTarget as HTMLElement).dataset.fit as ImageFit;
        this.onFitChange?.(fit);
        this.hide();
      });
    });

    // Outside click - use capture phase and delay to avoid triggering on the opening click
    requestAnimationFrame(() => {
      document.addEventListener('click', this.handleOutsideClick, true);
    });

    // Keyboard
    document.addEventListener('keydown', this.handleKeydown);
  }

  private handleOutsideClick = (e: MouseEvent): void => {
    if (!this.container) return;
    
    // Check if click is inside the dropdown
    if (this.container.contains(e.target as Node)) {
      return;
    }
    
    // Check if click is on the mode button (toggle behavior handled in show())
    const modeBtn = document.getElementById('cr-mode-btn');
    if (modeBtn && modeBtn.contains(e.target as Node)) {
      return;
    }
    
    this.hide();
    this.onClose?.();
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.hide();
      this.onClose?.();
    }
  };
}

export const modePicker = new ModePicker();
