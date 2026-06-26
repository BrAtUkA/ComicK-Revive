import { MangaDetails, Chapter } from '@/types';
import { sourceRegistry } from '@/sources';
import { SourceError } from '@/sources/Source.interface';
import { bridgeFetchImage } from '@/utils/bridge';
import { isSourceUrl } from '@/utils/sourceDomains';
import { setupBackdropClose } from '@/utils/backdrop-close';

type SlugEditorState = 'idle' | 'loading' | 'success' | 'error';

const PLACEHOLDER_SVG = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 286%22><rect fill=%22%23333%22 width=%22200%22 height=%22286%22/></svg>";

const WARNING_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;

export class SlugEditor {
  private container: HTMLElement | null = null;
  private state: SlugEditorState = 'idle';
  private validatedDetails: MangaDetails | null = null;

  private currentSourceId: string = 'asura';
  private currentSlug: string = '';
  private onConfirm?: (newSlug: string, details: MangaDetails) => void;

  private boundHandleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.hide();
    }
  };

  show(
    sourceId: string,
    currentSlug: string,
    onConfirm: (newSlug: string, details: MangaDetails) => void
  ): void {
    this.currentSourceId = sourceId;
    this.currentSlug = currentSlug;
    this.onConfirm = onConfirm;
    this.state = 'idle';
    this.validatedDetails = null;

    this.createModal();
    document.addEventListener('keydown', this.boundHandleKeydown);
  }

  hide(): void {
    document.removeEventListener('keydown', this.boundHandleKeydown);
    this.container?.remove();
    this.container = null;
    this.validatedDetails = null;
  }

  private createModal(): void {
    document.getElementById('cr-slug-editor')?.remove();

    const source = sourceRegistry.get(this.currentSourceId);
    const sourceName = source?.name || this.currentSourceId;

    this.container = document.createElement('div');
    this.container.id = 'cr-slug-editor';
    this.container.className = 'cr-slug-editor-overlay';
    this.container.innerHTML = `
      <div class="cr-slug-editor-modal">
        <div class="cr-slug-editor-header">
          <h4>Edit Source Slug</h4>
          <span class="cr-slug-editor-source-badge">${this.escapeHtml(sourceName)}</span>
        </div>
        <div class="cr-slug-editor-body">
          <div class="cr-slug-editor-input-row">
            <input
              type="text"
              id="cr-slug-editor-input"
              class="cr-setting-input"
              value="${this.escapeHtml(this.currentSlug)}"
              placeholder="e.g. manga-name-12345"
              spellcheck="false"
              autocomplete="off"
            >
            <button class="cr-slug-editor-check-btn" id="cr-slug-editor-check">Check</button>
          </div>
          <span class="cr-slug-editor-hint">Paste the manga slug from the source URL</span>
        </div>
        <div class="cr-slug-editor-result" id="cr-slug-editor-result"></div>
        <div class="cr-slug-editor-footer">
          <button class="cr-slug-editor-cancel" id="cr-slug-editor-cancel">Cancel</button>
          <button class="cr-slug-editor-apply" id="cr-slug-editor-apply" disabled>Apply</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.container);
    this.setupEventListeners();

    // Focus the input
    const input = document.getElementById('cr-slug-editor-input') as HTMLInputElement;
    input?.focus();
    input?.select();
  }

  private setupEventListeners(): void {
    // Check button
    document.getElementById('cr-slug-editor-check')?.addEventListener('click', () => {
      this.validateSlug();
    });

    // Apply button
    document.getElementById('cr-slug-editor-apply')?.addEventListener('click', () => {
      this.handleConfirm();
    });

    // Cancel button
    document.getElementById('cr-slug-editor-cancel')?.addEventListener('click', () => {
      this.hide();
    });

    // Input: Enter to validate, any change resets state
    const input = document.getElementById('cr-slug-editor-input') as HTMLInputElement;
    input?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.validateSlug();
      }
    });

    input?.addEventListener('input', () => {
      if (this.state !== 'idle') {
        this.state = 'idle';
        this.validatedDetails = null;
        this.clearResult();
        this.setApplyEnabled(false);
      }
    });

    // Click outside modal to close
    if (this.container) {
      setupBackdropClose(this.container, () => this.hide());
    }
  }

  private async validateSlug(): Promise<void> {
    const input = document.getElementById('cr-slug-editor-input') as HTMLInputElement;
    const slug = input?.value.trim();
    if (!slug) return;

    this.state = 'loading';
    this.validatedDetails = null;
    this.setApplyEnabled(false);
    this.setCheckEnabled(false);
    this.renderLoading();

    try {
      const source = sourceRegistry.get(this.currentSourceId);
      if (!source) throw new Error('Source not available');

      // Fetch details and chapters in parallel
      const [details, chapters] = await Promise.all([
        source.getMangaDetails(slug),
        source.getChapterList(slug).catch(() => [] as Chapter[]),
      ]);

      // Dialog may have been closed while fetching
      if (!this.container?.isConnected) return;

      this.validatedDetails = details;
      this.state = 'success';

      // Update input to canonical slug so the user sees exactly what gets saved
      if (input && details.slug !== slug) {
        input.value = details.slug;
      }

      this.renderDetails(details, chapters);
      this.setApplyEnabled(true);
    } catch (error) {
      if (!this.container?.isConnected) return;

      this.state = 'error';

      if (error instanceof SourceError) {
        switch (error.code) {
          case 'NOT_FOUND':
            this.renderError('Manga not found on this source. Check the slug and try again.');
            break;
          case 'NETWORK':
            this.renderError('Network error. Check your connection and try again.');
            break;
          case 'RATE_LIMITED':
            this.renderError('Rate limited by source. Please wait and try again.');
            break;
          default:
            this.renderError(`Error: ${error.message}`);
        }
      } else {
        this.renderError(`Failed to validate: ${(error as Error).message}`);
      }
    } finally {
      if (this.container?.isConnected) {
        this.setCheckEnabled(true);
      }
    }
  }

  private renderDetails(details: MangaDetails, chapters: Chapter[]): void {
    const resultEl = document.getElementById('cr-slug-editor-result');
    if (!resultEl) return;

    const sortedChapters = [...chapters].sort((a, b) => b.number - a.number);

    resultEl.innerHTML = `
      <div class="cr-slug-editor-details">
        <div class="cr-details-meta">
          <div class="cr-details-cover-container">
            <img
              class="cr-details-cover"
              id="cr-slug-editor-cover"
              src="${PLACEHOLDER_SVG}"
              data-original-url="${this.escapeHtml(details.thumbnailUrl)}"
              alt="${this.escapeHtml(details.title)}"
            >
          </div>
          <div class="cr-details-info">
            <h4 class="cr-details-title">${this.escapeHtml(details.title)}</h4>
            <div class="cr-slug-editor-details-slug" title="${this.escapeHtml(details.slug)}">${this.escapeHtml(details.slug)}</div>
            <div class="cr-details-field">
              <span class="cr-details-label">Author</span>
              <span class="cr-details-value">${this.escapeHtml(details.author || 'Unknown')}</span>
            </div>
            ${details.artist && details.artist !== details.author ? `
              <div class="cr-details-field">
                <span class="cr-details-label">Artist</span>
                <span class="cr-details-value">${this.escapeHtml(details.artist)}</span>
              </div>
            ` : ''}
            <div class="cr-details-field">
              <span class="cr-details-label">Status</span>
              <span class="cr-details-value">${this.escapeHtml(details.status || 'Unknown')}</span>
            </div>
            <div class="cr-details-field">
              <span class="cr-details-label">Chapters</span>
              <span class="cr-details-value">${chapters.length}</span>
            </div>
            ${details.genres.length > 0 ? `
              <div class="cr-details-genres">
                ${details.genres.map(g => `<span class="cr-details-genre">${this.escapeHtml(g)}</span>`).join('')}
              </div>
            ` : ''}
          </div>
        </div>
        ${details.description ? `
          <div class="cr-details-description">
            <p>${this.escapeHtml(details.description)}</p>
          </div>
        ` : ''}
        ${chapters.length > 0 ? `
          <div class="cr-details-chapters-header">
            <span>Chapters (${chapters.length})</span>
          </div>
          <div class="cr-details-chapter-list">
            ${sortedChapters.map(ch => `
              <div class="cr-details-chapter-item">
                <span class="cr-details-ch-number">Ch. ${ch.number}</span>
                <span class="cr-details-ch-title">${this.escapeHtml(ch.title || '')}</span>
                <span class="cr-details-ch-date">${this.formatDate(ch.dateUpload)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;

    // Proxy cover image
    if (details.thumbnailUrl) {
      const cover = document.getElementById('cr-slug-editor-cover') as HTMLImageElement;
      if (cover && isSourceUrl(details.thumbnailUrl)) {
        bridgeFetchImage(details.thumbnailUrl)
          .then(dataUrl => {
            if (cover.isConnected) cover.src = dataUrl;
          })
          .catch(() => {});
      } else if (cover && details.thumbnailUrl) {
        cover.src = details.thumbnailUrl;
        cover.onerror = () => { cover.src = PLACEHOLDER_SVG; };
      }
    }
  }

  private renderLoading(): void {
    const resultEl = document.getElementById('cr-slug-editor-result');
    if (!resultEl) return;

    resultEl.innerHTML = `
      <div class="cr-slug-editor-loading">
        <div class="cr-slug-editor-spinner"></div>
        <span>Resolving slug...</span>
      </div>
    `;
  }

  private renderError(message: string): void {
    const resultEl = document.getElementById('cr-slug-editor-result');
    if (!resultEl) return;

    resultEl.innerHTML = `
      <div class="cr-slug-editor-error">
        ${WARNING_ICON}
        <span>${this.escapeHtml(message)}</span>
      </div>
    `;
  }

  private clearResult(): void {
    const resultEl = document.getElementById('cr-slug-editor-result');
    if (resultEl) resultEl.innerHTML = '';
  }

  private setApplyEnabled(enabled: boolean): void {
    const btn = document.getElementById('cr-slug-editor-apply') as HTMLButtonElement;
    if (btn) btn.disabled = !enabled;
  }

  private setCheckEnabled(enabled: boolean): void {
    const btn = document.getElementById('cr-slug-editor-check') as HTMLButtonElement;
    if (btn) btn.disabled = !enabled;
  }

  private handleConfirm(): void {
    if (this.state !== 'success' || !this.validatedDetails) return;

    // Use the resolved slug from the source response, not the user's raw input
    const slug = this.validatedDetails.slug;
    this.onConfirm?.(slug, this.validatedDetails);
    this.hide();
  }

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

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

export const slugEditor = new SlugEditor();
