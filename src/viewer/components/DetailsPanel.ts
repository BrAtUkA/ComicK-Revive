import { SearchResult, MangaDetails, Chapter } from '@/types';
import { sourceRegistry } from '@/sources';
import { isSourceUrl } from '@/utils/sourceDomains';
import { bridgeFetchImage } from '@/utils/bridge';
import { showAltTitlesPopup } from './alt-titles-popup';

export interface DetailsPanelHost {
  readonly container: HTMLElement | null;
  readonly currentSourceId: string;
  readonly thumbnailCache: Map<string, string>;
  readonly chapterCountCache: Map<string, number>;
  getSearchResults(): SearchResult[];
  getAlternateTitles(): string[];
  escapeHtml(text: string): string;
  getThumbnailSrc(url: string): string;
  getSourceNameById(id: string): string;
  selectResult(result: SearchResult): Promise<void>;
}

/**
 * DetailsPanel - Slide-in overlay showing manga details and chapter list.
 * Fetches MangaDetails + ChapterList in parallel from the source.
 */
export class DetailsPanel {
  private detailsPanel: HTMLElement | null = null;

  constructor(private host: DetailsPanelHost) {}

  /**
   * Whether the details panel is currently visible.
   */
  isVisible(): boolean {
    return this.detailsPanel !== null;
  }

  /**
   * Show details overlay panel for a search result.
   * Fetches MangaDetails + ChapterList in parallel.
   */
  async showDetailsPanel(result: SearchResult): Promise<void> {
    this.hideDetailsPanel();

    const modal = this.host.container?.querySelector('.cr-modal');
    if (!modal) return;

    const sourceId = result.sourceId || this.host.currentSourceId;
    const source = sourceRegistry.get(sourceId);
    if (!source) return;

    this.detailsPanel = document.createElement('div');
    this.detailsPanel.className = 'cr-details-panel';
    this.detailsPanel.innerHTML = `
      <div class="cr-details-header">
        <button class="cr-details-back" id="cr-details-back">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
          Back to results
        </button>
        <span class="cr-source-badge">${this.host.getSourceNameById(sourceId)}</span>
      </div>
      <div class="cr-details-body">
        <div class="cr-details-loading">
          <div class="cr-progress-icon"></div>
          <span>Loading details...</span>
        </div>
      </div>
    `;

    modal.appendChild(this.detailsPanel);
    modal.classList.add('cr-details-open');

    this.detailsPanel.querySelector('#cr-details-back')?.addEventListener('click', () => {
      this.hideDetailsPanel();
    });

    try {
      const [details, chapters] = await Promise.all([
        source.getMangaDetails(result.slug),
        source.getChapterList(result.slug),
      ]);

      if (!this.detailsPanel?.isConnected) return;
      this.renderDetailsContent(details, chapters, sourceId, result);
    } catch (error) {
      if (!this.detailsPanel?.isConnected) return;
      const body = this.detailsPanel.querySelector('.cr-details-body');
      if (body) {
        body.innerHTML = `
          <div class="cr-details-error">
            <span>Failed to load details: ${(error as Error).message}</span>
            <button class="cr-retry-btn cr-details-retry">Retry</button>
          </div>
        `;
        body.querySelector('.cr-details-retry')?.addEventListener('click', () => {
          this.showDetailsPanel(result);
        });
      }
    }
  }

  /**
   * Render details content after data is fetched.
   */
  private renderDetailsContent(details: MangaDetails, chapters: Chapter[], sourceId: string, result: SearchResult): void {
    const body = this.detailsPanel?.querySelector('.cr-details-body');
    if (!body) return;

    const sortedChapters = [...chapters].sort((a, b) => b.number - a.number);
    const altTitles = this.host.getAlternateTitles();

    body.innerHTML = `
      <div class="cr-details-meta">
        <div class="cr-details-cover-container">
          <img
            class="cr-details-cover"
            src="${this.host.getThumbnailSrc(details.thumbnailUrl)}"
            data-original-url="${details.thumbnailUrl}"
            alt="${this.host.escapeHtml(details.title)}"
            onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 300%22><rect fill=%22%23333%22 width=%22200%22 height=%22300%22/></svg>'"
          >
        </div>
        <div class="cr-details-info">
          <h4 class="cr-details-title">${this.host.escapeHtml(details.title)}${altTitles.length > 1 ? `<span class="cr-details-alt-badge" title="View alternate titles">+${altTitles.length - 1} more</span>` : ''}</h4>
          <div class="cr-details-field">
            <span class="cr-details-label">Author</span>
            <span class="cr-details-value">${this.host.escapeHtml(details.author || 'Unknown')}</span>
          </div>
          ${details.artist && details.artist !== details.author ? `
            <div class="cr-details-field">
              <span class="cr-details-label">Artist</span>
              <span class="cr-details-value">${this.host.escapeHtml(details.artist)}</span>
            </div>
          ` : ''}
          <div class="cr-details-field">
            <span class="cr-details-label">Status</span>
            <span class="cr-details-value">${this.host.escapeHtml(details.status || 'Unknown')}</span>
          </div>
          <div class="cr-details-field">
            <span class="cr-details-label">Chapters</span>
            <span class="cr-details-value">${chapters.length}</span>
          </div>
          ${chapters.length > 0 ? `
          <button class="cr-details-start-reading" id="cr-details-start-reading">
            Start Reading
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/>
            </svg>
          </button>
          ` : `
          <button class="cr-details-start-reading" disabled>
            No chapters available
          </button>
          `}
          ${details.genres.length > 0 ? `
            <div class="cr-details-genres">
              ${details.genres.map(g => `<span class="cr-details-genre">${this.host.escapeHtml(g)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
      ${details.description ? `
        <div class="cr-details-description">
          <p>${this.host.escapeHtml(details.description)}</p>
        </div>
      ` : ''}
      <div class="cr-details-chapters-header">
        <span>Chapters (${chapters.length})</span>
      </div>
      <div class="cr-details-chapter-list">
        ${chapters.length > 0 ? sortedChapters.map(ch => `
          <div class="cr-details-chapter-item">
            <span class="cr-details-ch-number">Ch. ${ch.number}</span>
            <span class="cr-details-ch-title">${this.host.escapeHtml(ch.title || '')}</span>
            <span class="cr-details-ch-date">${this.formatDate(ch.dateUpload)}</span>
          </div>
        `).join('') : `
          <div class="cr-details-chapter-item" style="justify-content: center; color: #666; font-style: italic;">
            No chapters found for this manga.
          </div>
        `}
      </div>
    `;

    // Proxy cover image if needed
    const coverImg = body.querySelector<HTMLImageElement>('.cr-details-cover');
    if (coverImg) {
      const originalUrl = coverImg.dataset.originalUrl;
      if (originalUrl && isSourceUrl(originalUrl) && !this.host.thumbnailCache.has(originalUrl)) {
        bridgeFetchImage(originalUrl).then(dataUrl => {
          this.host.thumbnailCache.set(originalUrl, dataUrl);
          if (coverImg.isConnected) coverImg.src = dataUrl;
        }).catch(() => {});
      }
    }

    // Populate chapter count cache (saves redundant fetch if user goes back)
    const cacheKey = `${sourceId}:${details.slug}`;
    this.host.chapterCountCache.set(cacheKey, chapters.length);

    // Wire "Start Reading" button
    body.querySelector('#cr-details-start-reading')?.addEventListener('click', () => {
      this.host.selectResult(result);
    });

    // Wire alt titles badge
    body.querySelector('.cr-details-alt-badge')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showAltTitlesPopup(this.host.getAlternateTitles(), this.host.escapeHtml);
    });
  }

  /**
   * Format a timestamp to a relative or short date string.
   */
  private formatDate(timestamp: number): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  hideDetailsPanel(): void {
    if (this.detailsPanel) {
      this.detailsPanel.closest('.cr-modal')?.classList.remove('cr-details-open');
      this.detailsPanel.remove();
    }
    this.detailsPanel = null;
  }
}
