/**
 * Sets up click-outside-to-close on an overlay element, but only when both
 * mousedown and click originate on the overlay backdrop itself.
 *
 * Prevents accidental closes when the user starts a click inside the modal
 * (e.g. drag-selecting text) and releases outside it.
 */
export function setupBackdropClose(overlay: HTMLElement, onClose: () => void): void {
  let mouseDownOnBackdrop = false;

  overlay.addEventListener('mousedown', (e: MouseEvent) => {
    mouseDownOnBackdrop = (e.target === overlay);
  });

  overlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === overlay && mouseDownOnBackdrop) {
      onClose();
    }
    mouseDownOnBackdrop = false;
  });
}
