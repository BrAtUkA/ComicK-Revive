/**
 * Shared dashboard modal with strict close behavior: the X button, or a
 * click where BOTH mousedown and mouseup land on the backdrop. A text
 * selection dragged out of the modal never closes it.
 */

const X_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

export interface ModalOptions {
  large?: boolean;
  headerActions?: string;
}

export function buildModal(
  title: string,
  bodyHtml: string,
  options: ModalOptions = {}
): { overlay: HTMLElement; close: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'crd-modal-overlay';
  overlay.innerHTML = `
    <div class="crd-modal${options.large ? ' large' : ''}">
      <div class="crd-modal-head">
        <h3>${title}</h3>
        <span class="crd-modal-head-actions">${options.headerActions ?? ''}<button class="crd-icon-btn crd-modal-x" title="Close">${X_SVG}</button></span>
      </div>
      ${bodyHtml}
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();

  let downOnBackdrop = false;
  overlay.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === overlay; });
  overlay.addEventListener('mouseup', (e) => {
    if (downOnBackdrop && e.target === overlay) close();
    downOnBackdrop = false;
  });
  overlay.querySelector('.crd-modal-x')?.addEventListener('click', close);
  return { overlay, close };
}
