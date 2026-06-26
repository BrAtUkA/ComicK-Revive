/**
 * Toast - Subtle page-level notification toast
 *
 * Shows a small toast at the bottom-right of the viewport.
 * Appends directly to document.body so it's visible above all overlays.
 */

const TOAST_DURATION = 4000;
const TOAST_ID = 'cr-toast';
const TOAST_DETAIL_ID = 'cr-toast-detail';

/**
 * Show a toast notification.
 * @param message - Text to display
 * @param options.details - Detail text shown when clicking the info icon
 * @param options.onDismiss - Callback when "don't show again" is clicked
 */
export function showToast(message: string, options?: { details?: string; onDismiss?: () => void }): void {
  document.getElementById(TOAST_ID)?.remove();
  document.getElementById(TOAST_DETAIL_ID)?.remove();

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.className = 'cr-toast';

  // Info icon (only interactive if details provided)
  const icon = document.createElement('span');
  icon.className = 'cr-toast-icon';
  icon.textContent = 'i';
  if (options?.details) {
    icon.classList.add('cr-toast-icon-clickable');
    icon.addEventListener('click', () => {
      const existing = document.getElementById(TOAST_DETAIL_ID);
      if (existing) { existing.remove(); return; }

      const popup = document.createElement('div');
      popup.id = TOAST_DETAIL_ID;
      popup.className = 'cr-toast-detail';

      // Render details with structure
      popup.innerHTML = formatDetailsHTML(options.details!);

      // Position above the icon with nip pointing down
      document.body.appendChild(popup);
      const iconRect = icon.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();

      // Center popup horizontally over the icon, but clamp to viewport
      let left = iconRect.left + iconRect.width / 2 - popupRect.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - popupRect.width - 8));
      popup.style.left = left + 'px';
      popup.style.bottom = (window.innerHeight - iconRect.top + 8) + 'px';

      // Position the nip to point at the icon center
      const nipLeft = iconRect.left + iconRect.width / 2 - left;
      popup.style.setProperty('--nip-left', nipLeft + 'px');
    });
  }
  toast.appendChild(icon);

  // Message + optional dismiss as a vertical stack
  const body = document.createElement('div');
  body.className = 'cr-toast-body';

  const text = document.createElement('span');
  text.textContent = message;
  body.appendChild(text);

  if (options?.onDismiss) {
    const dismiss = document.createElement('span');
    dismiss.className = 'cr-toast-dismiss';
    dismiss.textContent = "don't show again";
    dismiss.addEventListener('click', () => {
      options.onDismiss!();
      toast.remove();
      document.getElementById(TOAST_DETAIL_ID)?.remove();
    });
    body.appendChild(dismiss);
  }

  toast.appendChild(body);

  // Close button
  const close = document.createElement('span');
  close.className = 'cr-toast-close';
  close.textContent = '\u00D7';
  close.addEventListener('click', () => {
    toast.remove();
    document.getElementById(TOAST_DETAIL_ID)?.remove();
  });
  toast.appendChild(close);

  // Pause auto-dismiss on hover (also pause when hovering the detail popup)
  const removeToast = () => {
    toast.remove();
    document.getElementById(TOAST_DETAIL_ID)?.remove();
  };
  let timer = setTimeout(removeToast, TOAST_DURATION);
  const pauseTimer = () => {
    clearTimeout(timer);
    toast.style.animationPlayState = 'paused';
  };
  const resumeTimer = () => {
    toast.style.animationPlayState = 'running';
    timer = setTimeout(removeToast, TOAST_DURATION);
  };
  toast.addEventListener('mouseenter', pauseTimer);
  toast.addEventListener('mouseleave', () => {
    // Don't resume if hovering the detail popup
    if (document.getElementById(TOAST_DETAIL_ID)?.matches(':hover')) return;
    resumeTimer();
  });

  // Also pause when hovering the detail popup (use event delegation on body)
  const detailHoverHandler = (e: MouseEvent) => {
    const detail = document.getElementById(TOAST_DETAIL_ID);
    if (!detail) return;
    if (detail.contains(e.target as Node)) {
      pauseTimer();
    }
  };
  const detailLeaveHandler = (e: MouseEvent) => {
    const detail = document.getElementById(TOAST_DETAIL_ID);
    if (!detail) return;
    if (detail.contains(e.relatedTarget as Node) || toast.contains(e.relatedTarget as Node)) return;
    resumeTimer();
  };
  document.addEventListener('mouseenter', detailHoverHandler, true);
  document.addEventListener('mouseleave', detailLeaveHandler, true);

  // Clean up listeners when toast is removed
  const observer = new MutationObserver(() => {
    if (!document.contains(toast)) {
      document.removeEventListener('mouseenter', detailHoverHandler, true);
      document.removeEventListener('mouseleave', detailLeaveHandler, true);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  document.body.appendChild(toast);
}

/** Format detail text into HTML with manga/chapter structure */
function formatDetailsHTML(details: string): string {
  const lines = details.split('\n');
  let html = '';
  for (const line of lines) {
    if (line.startsWith('  ')) {
      // Chapter line (indented)
      html += `<div class="cr-toast-detail-chapter">${escapeHtml(line.trim())}</div>`;
    } else {
      // Manga name header
      html += `<div class="cr-toast-detail-manga">${escapeHtml(line)}</div>`;
    }
  }
  return html;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
