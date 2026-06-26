/**
 * Shared alternate titles popup dialog.
 * Shows a scrollable list of titles with click-to-copy.
 * Used by DetailsPanel and CacheManager.
 */
import { setupBackdropClose } from '@/utils/backdrop-close';

export function showAltTitlesPopup(titles: string[], escapeHtml: (s: string) => string): void {
  document.getElementById('cr-alt-titles-popup')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'cr-alt-titles-popup';
  overlay.className = 'cr-confirm-overlay';
  overlay.innerHTML = `
    <div class="cr-alt-titles-modal">
      <div class="cr-alt-titles-header">
        <h4>Alternate Titles</h4>
        <span class="cr-alt-titles-count">${titles.length} title${titles.length === 1 ? '' : 's'}</span>
      </div>
      <div class="cr-alt-titles-hint">Click a title to copy</div>
      <div class="cr-alt-titles-list">
        ${titles.map((t, i) => `
          <div class="cr-alt-titles-item" data-copy-text="${escapeHtml(t)}">
            <span class="cr-alt-titles-index">${i + 1}</span>
            <span class="cr-alt-titles-text">${escapeHtml(t)}</span>
          </div>
        `).join('')}
      </div>
      <div class="cr-alt-titles-footer">
        <button class="cr-confirm-cancel" id="cr-alt-titles-close">Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Click-to-copy on title items
  overlay.querySelector('.cr-alt-titles-list')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.cr-alt-titles-item') as HTMLElement | null;
    if (!item?.dataset.copyText) return;

    navigator.clipboard.writeText(item.dataset.copyText).then(() => {
      item.classList.add('cr-alt-titles-copied');
      setTimeout(() => item.classList.remove('cr-alt-titles-copied'), 1200);
    });
  });

  const close = () => {
    document.removeEventListener('keydown', handleEsc);
    overlay.remove();
  };

  document.getElementById('cr-alt-titles-close')?.addEventListener('click', close);
  setupBackdropClose(overlay, close);

  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    }
  };
  document.addEventListener('keydown', handleEsc);
}
