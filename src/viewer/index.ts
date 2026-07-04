import { viewer } from './Viewer';
import { ComickPageData } from '@/types';
import './Viewer.css';
import './components/icons.css';

/**
 * Viewer Entry Point
 *
 * Listens for events from content script to open the viewer
 */

let hasOpenedFromPending = false;

// Listen for open viewer event (dispatched by content script)
window.addEventListener('comick-revive-open', ((event: CustomEvent<ComickPageData>) => {
  // Skip if we already opened from pending data (prevents double-open on first load)
  if (hasOpenedFromPending) {
    hasOpenedFromPending = false;
    console.log('[ComicK Revive] Skipping duplicate open event (already opened from pending data)');
    return;
  }
  console.log('[ComicK Revive] Received open event:', event.detail);
  const pageData = event.detail;
  viewer.open(pageData);
}) as EventListener);

// Also check if there's page data waiting (set before script loaded)
const pendingPageData = (window as any).__comickRevivePageData;
if (pendingPageData) {
  console.log('[ComicK Revive] Found pending page data, opening viewer');
  hasOpenedFromPending = true;
  setTimeout(() => {
    viewer.open(pendingPageData);
    delete (window as any).__comickRevivePageData;
  }, 50);
}

// Export viewer for direct access
export { viewer };

console.log('[ComicK Revive] Viewer module loaded');
