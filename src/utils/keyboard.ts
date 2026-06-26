/**
 * Keyboard shortcut definitions and handler
 */
export interface KeyboardAction {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: string;
  description: string;
}

export const KEYBOARD_SHORTCUTS: KeyboardAction[] = [
  { key: 'Escape', action: 'close', description: 'Stop reading' },
  { key: 'w', action: 'prevPage', description: 'Previous page' },
  { key: 's', action: 'nextPage', description: 'Next page' },
  { key: 'a', action: 'prevChapter', description: 'Previous chapter' },
  { key: 'd', action: 'nextChapter', description: 'Next chapter' },
  { key: 'Home', action: 'scrollToTop', description: 'Scroll to top' },
  { key: ' ', action: 'scrollDown', description: 'Scroll down' },
  { key: ' ', shift: true, action: 'scrollUp', description: 'Scroll up' },
  { key: 'ArrowUp', action: 'prevPage', description: 'Previous page' },
  { key: 'ArrowDown', action: 'nextPage', description: 'Next page' },
  { key: 'ArrowLeft', action: 'prevChapter', description: 'Previous chapter' },
  { key: 'ArrowRight', action: 'nextChapter', description: 'Next chapter' },
  { key: 'f', action: 'fullscreen', description: 'Toggle fullscreen' },
  { key: 'g', action: 'settings', description: 'Open settings' },
  { key: 't', action: 'toggleToolbar', description: 'Toggle toolbar' },
  { key: '1', action: 'modeVertical', description: 'Vertical scroll mode' },
  { key: '2', action: 'modeSingle', description: 'Single page mode' },
  { key: '3', action: 'modeDouble', description: 'Double page mode' },
  { key: '+', action: 'zoomIn', description: 'Zoom in' },
  { key: '=', action: 'zoomIn', description: 'Zoom in' },
  { key: '-', action: 'zoomOut', description: 'Zoom out' },
  { key: '0', action: 'zoomReset', description: 'Reset zoom' },
];

export type KeyboardActionType = typeof KEYBOARD_SHORTCUTS[number]['action'];

export class KeyboardHandler {
  private enabled: boolean = true;
  private listeners: Map<KeyboardActionType, Set<() => void>> = new Map();
  private heldActions: Set<string> = new Set();

  constructor() {
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
  }

  /**
   * Start listening for keyboard events
   */
  attach(element: HTMLElement | Document = document): void {
    element.addEventListener('keydown', this.handleKeyDown as EventListener);
    element.addEventListener('keyup', this.handleKeyUp as EventListener);
    window.addEventListener('blur', this.handleBlur);
  }

  /**
   * Stop listening for keyboard events
   */
  detach(element: HTMLElement | Document = document): void {
    element.removeEventListener('keydown', this.handleKeyDown as EventListener);
    element.removeEventListener('keyup', this.handleKeyUp as EventListener);
    window.removeEventListener('blur', this.handleBlur);
    this.clearAllHolds();
  }

  /**
   * Enable/disable keyboard shortcuts
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearAllHolds();
    }
  }

  /**
   * Register action listener
   */
  on(action: KeyboardActionType, callback: () => void): () => void {
    if (!this.listeners.has(action)) {
      this.listeners.set(action, new Set());
    }
    this.listeners.get(action)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(action)?.delete(callback);
    };
  }

  /**
   * Remove action listener
   */
  off(action: KeyboardActionType, callback: () => void): void {
    this.listeners.get(action)?.delete(callback);
  }

  /**
   * Handle keydown event
   */
  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.enabled) return;

    // Don't capture if user is typing in an input
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target as HTMLElement)?.isContentEditable
    ) {
      return;
    }

    const shortcut = this.matchShortcut(event);
    if (shortcut) {
      event.preventDefault();
      event.stopPropagation();

      const action = shortcut.action as KeyboardActionType;

      if (event.repeat) {
        // Key is being held — emit holdStart on first repeat only
        if (!this.heldActions.has(action)) {
          this.heldActions.add(action);
          this.triggerAction(`holdStart:${action}` as KeyboardActionType);
        }
        // Suppress normal action during hold repeats
      } else {
        // First press (non-repeat) — emit normal tap action
        this.triggerAction(action);
      }
    }
  }

  /**
   * Handle keyup event
   */
  private handleKeyUp(event: KeyboardEvent): void {
    if (!this.enabled) return;

    const shortcut = this.matchShortcut(event);
    if (shortcut) {
      const action = shortcut.action as KeyboardActionType;
      if (this.heldActions.has(action)) {
        this.heldActions.delete(action);
        this.triggerAction(`holdEnd:${action}` as KeyboardActionType);
      }
    }
  }

  /**
   * Clear all held actions (emits holdEnd for each)
   */
  private clearAllHolds(): void {
    for (const action of this.heldActions) {
      this.triggerAction(`holdEnd:${action}` as KeyboardActionType);
    }
    this.heldActions.clear();
  }

  /** Handle window blur — stop all holds */
  private handleBlur = (): void => {
    this.clearAllHolds();
  };

  /**
   * Find matching shortcut for event
   */
  private matchShortcut(event: KeyboardEvent): KeyboardAction | null {
    for (const shortcut of KEYBOARD_SHORTCUTS) {
      const keyMatches = event.key.toLowerCase() === shortcut.key.toLowerCase() ||
                        event.key === shortcut.key;
      const ctrlMatches = !!shortcut.ctrl === event.ctrlKey;
      const shiftMatches = !!shortcut.shift === event.shiftKey;
      const altMatches = !!shortcut.alt === event.altKey;

      if (keyMatches && ctrlMatches && shiftMatches && altMatches) {
        return shortcut;
      }
    }
    return null;
  }

  /**
   * Trigger action callbacks
   */
  private triggerAction(action: KeyboardActionType): void {
    const callbacks = this.listeners.get(action);
    if (callbacks) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }

  /**
   * Get all shortcuts for display
   */
  static getShortcutList(): KeyboardAction[] {
    return [...KEYBOARD_SHORTCUTS];
  }

  /**
   * Format shortcut for display (e.g., "Shift + Space")
   */
  static formatShortcut(shortcut: KeyboardAction): string {
    const parts: string[] = [];
    if (shortcut.ctrl) parts.push('Ctrl');
    if (shortcut.shift) parts.push('Shift');
    if (shortcut.alt) parts.push('Alt');

    // Format special keys
    let key = shortcut.key;
    if (key === ' ') key = 'Space';
    if (key === 'Escape') key = 'Esc';
    parts.push(key.toUpperCase());

    return parts.join(' + ');
  }
}
