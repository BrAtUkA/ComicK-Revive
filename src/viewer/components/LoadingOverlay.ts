type OverlayState = 'loading' | 'error' | 'hidden';

/**
 * Self-contained overlay for loading, progress, and error states.
 * Owns its own DOM, timers, and CSS class management.
 */
export class LoadingOverlay {
  private root: HTMLElement | null = null;
  private messageEl: HTMLElement | null = null;
  private retryBtn: HTMLElement | null = null;

  private state: OverlayState = 'hidden';

  // Progress tracking
  private progressLabel = '';
  private progressDelayElapsed = false;
  private progressDelayTimer: ReturnType<typeof setTimeout> | null = null;

  // Fade-out fallback
  private fadeoutFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // Retry callback
  private onRetryCallback: (() => void) | null = null;

  /**
   * Create overlay DOM and append to parent.
   */
  mount(parent: HTMLElement): void {
    if (this.root) return;

    const overlay = document.createElement('div');
    overlay.className = 'cr-viewer-overlay cr-overlay-hidden';
    overlay.id = 'cr-overlay';
    overlay.innerHTML = `
      <div class="cr-overlay-content">
        <div class="cr-overlay-spinner"></div>
        <p class="cr-overlay-message">Loading...</p>
        <button class="cr-overlay-retry-btn" style="display: none;">Retry</button>
      </div>
    `;

    this.root = overlay;
    this.messageEl = overlay.querySelector('.cr-overlay-message');
    this.retryBtn = overlay.querySelector('.cr-overlay-retry-btn');

    this.retryBtn?.addEventListener('click', () => {
      this.onRetryCallback?.();
    });

    parent.appendChild(overlay);
  }

  /**
   * Remove DOM and clear all timers.
   */
  unmount(): void {
    this.clearAllTimers();
    this.root?.remove();
    this.root = null;
    this.messageEl = null;
    this.retryBtn = null;
    this.state = 'hidden';
  }

  /**
   * Show just the dark backdrop with no spinner or message.
   * Used as a subtle crossfade transition between chapters.
   * Can be upgraded to full loading state via showLoading().
   */
  showTransition(): void {
    if (!this.root) return;

    this.clearAllTimers();
    this.state = 'loading';

    const el = this.root;
    el.classList.remove('cr-overlay-hidden', 'cr-overlay-loading', 'cr-overlay-error', 'cr-fade-out');
    // No state class → CSS hides spinner and message, only dark bg visible

    if (this.retryBtn) {
      this.retryBtn.style.display = 'none';
    }

    el.style.display = '';
  }

  /**
   * Show loading state with spinner and message, both immediately visible.
   */
  showLoading(message: string): void {
    if (!this.root) return;

    this.clearAllTimers();
    this.state = 'loading';

    const el = this.root;
    el.classList.remove('cr-overlay-hidden', 'cr-overlay-loading', 'cr-overlay-error', 'cr-fade-out');
    el.classList.add('cr-overlay-loading');

    if (this.messageEl) {
      this.messageEl.textContent = message;
    }
    if (this.retryBtn) {
      this.retryBtn.style.display = 'none';
    }

    el.style.display = '';
  }

  /**
   * Show error state with message and optional retry callback.
   */
  showError(message: string, onRetry?: () => void): void {
    if (!this.root) return;

    this.clearAllTimers();
    this.state = 'error';
    this.onRetryCallback = onRetry || null;

    const el = this.root;
    el.classList.remove('cr-overlay-hidden', 'cr-overlay-loading', 'cr-overlay-error', 'cr-fade-out');
    el.classList.add('cr-overlay-error');

    if (this.messageEl) {
      this.messageEl.textContent = message;
    }
    if (this.retryBtn) {
      this.retryBtn.style.display = onRetry ? '' : 'none';
    }

    el.style.display = '';
  }

  /**
   * Update message text without changing overlay state.
   */
  setMessage(message: string): void {
    if (this.messageEl) {
      this.messageEl.textContent = message;
    }
  }

  /**
   * Enable progress reporting. After delayMs elapses, subsequent
   * updateProgress() calls will modify the message.
   */
  enableProgress(label: string, delayMs: number = 2000): void {
    this.progressLabel = label;
    this.progressDelayElapsed = false;
    this.clearProgressTimer();
    this.progressDelayTimer = setTimeout(() => {
      this.progressDelayElapsed = true;
    }, delayMs);
  }

  /**
   * Update progress display. Only modifies message if progress
   * is enabled and the delay has elapsed.
   */
  updateProgress(loaded: number, total: number): void {
    if (!this.progressDelayElapsed || !this.messageEl) return;
    this.messageEl.textContent = `${this.progressLabel}... (${loaded} / ${total} pages)`;
  }

  /**
   * Hide overlay with 0.3s fade animation.
   */
  hide(): void {
    if (!this.root || this.state === 'hidden') return;

    this.clearAllTimers();
    this.state = 'hidden';

    const el = this.root;
    el.classList.add('cr-fade-out');

    const handleAnimationEnd = () => {
      el.classList.add('cr-overlay-hidden');
      el.classList.remove('cr-fade-out');
      el.style.display = 'none';
      el.removeEventListener('animationend', handleAnimationEnd);
    };

    el.addEventListener('animationend', handleAnimationEnd);

    // Fallback in case animation doesn't fire
    this.fadeoutFallbackTimer = setTimeout(() => {
      if (!el.classList.contains('cr-overlay-hidden')) {
        el.classList.add('cr-overlay-hidden');
        el.classList.remove('cr-fade-out');
        el.style.display = 'none';
      }
    }, 350);
  }

  /** Whether overlay is currently showing (loading or error). */
  get isVisible(): boolean {
    return this.state !== 'hidden';
  }

  private clearProgressTimer(): void {
    if (this.progressDelayTimer) {
      clearTimeout(this.progressDelayTimer);
      this.progressDelayTimer = null;
    }
    this.progressDelayElapsed = false;
  }

  private clearAllTimers(): void {
    this.clearProgressTimer();
    if (this.fadeoutFallbackTimer) {
      clearTimeout(this.fadeoutFallbackTimer);
      this.fadeoutFallbackTimer = null;
    }
  }
}
