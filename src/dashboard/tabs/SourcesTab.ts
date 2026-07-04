import { sourceRegistry } from '@/sources';
import { DeclarativeSource } from '@/sources/spec/DeclarativeSource';
import { validateSourceSpec, type SourceSpecV1 } from '@/sources/spec/SourceSpec';
import { sourceConfigManager, userSourcesManager } from '@/core';
import { fetchWithCors } from '@/utils/fetchWithCors';
import type { DashboardTab } from '../Dashboard';
import { showDashToast } from '../Dashboard';
import { buildModal } from '../modal';
import { ensureOriginPermissions, setRefererRule } from '../sourcePermissions';
import { createJsonEditor } from '../jsonEditor';
import { SPEC_AI_PROMPT } from '../spec-ai-prompt';
import { escapeHtml } from '@/shared/fmt';

const GRIP_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;
const FLASK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v6L4.5 18.5A2 2 0 0 0 6.24 21.5h11.52a2 2 0 0 0 1.74-3L14 8V2"/><line x1="8.5" y1="2" x2="15.5" y2="2"/><line x1="7" y1="14" x2="17" y2="14"/></svg>`;
const HELP_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><line x1="12" y1="17.5" x2="12.01" y2="17.5"/></svg>`;
const PENCIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`;
const DOWNLOAD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

/**
 * Sources — priority, enablement, custom domains, and user-added
 * declarative sources (import/edit/download + live test harness).
 */
export class SourcesTab implements DashboardTab {
  id = 'sources';
  label = 'Sources';
  icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17"/><path d="M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>`;

  private dragEl: HTMLElement | null = null;
  private host: HTMLElement | null = null;

  async mount(host: HTMLElement): Promise<void> {
    this.host = host;
    await sourceRegistry.refreshConfig();
    await sourceRegistry.loadUserSources();

    host.innerHTML = `
      <div class="crd-content">
        <h1 class="crd-tab-head">Sources</h1>
        <p class="crd-tab-sub">Drag to set priority. Search All queries sources top to bottom.</p>
        <div class="crd-src-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>Disabling a source hides it from new searches. Manga already linked to it keep working. User sources are JSON specs interpreted at runtime: no rebuild needed.</span>
        </div>
        <div id="crd-src-list"></div>
        <div class="crd-btn-row">
          <button class="crd-btn" id="crd-src-add">Add source</button>
        </div>
      </div>
    `;

    host.querySelector('#crd-src-add')?.addEventListener('click', () => this.openSpecModal());
    this.renderList(host.querySelector<HTMLElement>('#crd-src-list')!);
  }

  private renderList(list: HTMLElement): void {
    list.innerHTML = '';
    const sources = sourceRegistry.getAll({ includeDisabled: true });

    for (const source of sources) {
      const enabled = sourceRegistry.isEnabled(source.id);
      const isUser = sourceRegistry.isUserSource(source.id);
      const row = document.createElement('div');
      row.className = `crd-src-row${enabled ? '' : ' off'}`;
      row.dataset.id = source.id;
      row.draggable = true;
      const iconUrl = (source as { iconUrl?: string }).iconUrl;
      row.innerHTML = `
        <span class="crd-src-handle" title="Drag to reorder">${GRIP_SVG}</span>
        <div class="crd-src-icon">${iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="">` : escapeHtml(source.name.slice(0, 1))}</div>
        <div class="crd-src-body">
          <div class="crd-src-name">${escapeHtml(source.name)} ${isUser ? '<span class="crd-chip">user</span>' : '<span class="crd-chip builtin">built-in</span>'}</div>
          <div class="crd-src-url">
            <a href="${escapeHtml(source.baseUrl)}" target="_blank" rel="noopener">${escapeHtml(source.baseUrl.replace(/^https?:\/\//, ''))}</a>
            ${isUser ? '' : '<a class="crd-src-domain-edit" title="Use a custom domain (when the site moves)">domain</a>'}
          </div>
        </div>
        ${isUser ? `
          <span class="crd-src-actions">
            <button class="crd-icon-btn" data-act="test" title="Test against the live site">${FLASK_SVG}</button>
            <button class="crd-icon-btn" data-act="edit" title="Edit spec">${PENCIL_SVG}</button>
            <button class="crd-icon-btn danger" data-act="remove" title="Remove source">${TRASH_SVG}</button>
          </span>` : ''}
        <label class="crd-toggle" title="${enabled ? 'Enabled' : 'Hidden from new searches'}">
          <input type="checkbox" ${enabled ? 'checked' : ''}><i></i>
        </label>
      `;

      const img = row.querySelector<HTMLImageElement>('.crd-src-icon img');
      img?.addEventListener('load', () => {
        if (img.naturalHeight > 0 && img.naturalWidth > img.naturalHeight * 1.8) {
          img.parentElement?.classList.add('wide');
        }
      }, { once: true });

      row.querySelector<HTMLInputElement>('.crd-toggle input')?.addEventListener('change', async (e) => {
        const on = (e.target as HTMLInputElement).checked;
        await sourceConfigManager.setEnabled(source.id, on);
        showDashToast(on ? `${source.name} enabled` : `${source.name} hidden from new searches`);
        this.renderList(list);
      });

      row.querySelector('.crd-src-domain-edit')?.addEventListener('click', () => void this.editDomain(source.id, source.baseUrl, list));
      row.querySelector('[data-act="remove"]')?.addEventListener('click', () => void this.removeUserSource(source.id, source.name, list));
      row.querySelector('[data-act="test"]')?.addEventListener('click', () => void this.showTestModal(source.id));
      row.querySelector('[data-act="edit"]')?.addEventListener('click', () => void this.editUserSource(source.id));

      row.addEventListener('dragstart', (e) => {
        this.dragEl = row;
        row.classList.add('crd-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', source.id);
        }
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('crd-dragging');
        this.dragEl = null;
        void this.persistOrder(list);
      });

      list.appendChild(row);
    }

    list.addEventListener('dragover', this.onDragOver);
  }

  // ── Import / edit ─────────────────────────────────────────────────────────

  private openSpecModal(existing?: SourceSpecV1): void {
    const editing = !!existing;
    const { overlay, close } = buildModal(
      editing ? `Edit ${escapeHtml(existing!.name)}` : 'Add source',
      `
        <p class="crd-panel-desc">${editing
          ? 'Changes apply immediately after saving. Download a backup first if you are experimenting.'
          : "Paste a SourceSpec JSON, load a .json file, or fetch one from a URL. You'll be asked to grant access to the source's domain."}</p>
        <div class="crd-modal-row">
          <input type="text" class="crd-num crd-modal-url" id="crd-imp-url" placeholder="https://example.com/spec.json">
          <button class="crd-btn" id="crd-imp-fetch">Fetch</button>
          <button class="crd-btn" id="crd-imp-file">Load file</button>
        </div>
        <div id="crd-imp-editor"></div>
        <div class="crd-modal-errors" id="crd-imp-errors" hidden></div>
        <div class="crd-btn-row">
          <button class="crd-btn" id="crd-imp-add">${editing ? 'Save changes' : 'Validate & add'}</button>
          ${editing ? `<button class="crd-btn" id="crd-imp-download">${DOWNLOAD_SVG}&nbsp;Download JSON</button>` : ''}
        </div>
      `,
      {
        large: true,
        headerActions: `<button class="crd-btn crd-btn-small crd-help-pill" id="crd-imp-help-btn">${HELP_SVG}&nbsp;Help</button>`,
      }
    );

    const editor = createJsonEditor(existing ? JSON.stringify(existing, null, 2) : '');
    overlay.querySelector('#crd-imp-editor')?.appendChild(editor.root);
    const errors = overlay.querySelector<HTMLElement>('#crd-imp-errors')!;

    overlay.querySelector('#crd-imp-file')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (file) editor.set(await file.text());
      });
      input.click();
    });

    overlay.querySelector('#crd-imp-download')?.addEventListener('click', () => {
      let filename = 'source-spec.json';
      try { filename = `${(JSON.parse(editor.get()) as SourceSpecV1).id}.json`; } catch { /* unsaved draft */ }
      this.downloadText(editor.get(), filename);
    });

    overlay.querySelector('#crd-imp-help-btn')?.addEventListener('click', () => this.showHelpModal());

    overlay.querySelector('#crd-imp-fetch')?.addEventListener('click', async () => {
      const url = overlay.querySelector<HTMLInputElement>('#crd-imp-url')!.value.trim();
      if (!url) return;
      try {
        if (!await ensureOriginPermissions([url])) throw new Error('Permission declined');
        const response = await fetchWithCors(url);
        editor.set(await response.text());
        errors.hidden = true;
      } catch (error) {
        this.showErrors(errors, [`Fetch failed: ${(error as Error).message}`]);
      }
    });

    overlay.querySelector('#crd-imp-add')?.addEventListener('click', async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(editor.get());
      } catch {
        this.showErrors(errors, ['Not valid JSON']);
        return;
      }
      const problems = validateSourceSpec(parsed);
      const spec = parsed as SourceSpecV1;
      if (!problems.length && sourceRegistry.has(spec.id) && !sourceRegistry.isUserSource(spec.id)) {
        problems.push(`id "${spec.id}" collides with a built-in source`);
      }
      if (problems.length) {
        this.showErrors(errors, problems);
        return;
      }
      try {
        if (!await ensureOriginPermissions([spec.baseUrl, spec.iconUrl, spec.referer, ...(spec.imageHosts ?? [])])) {
          this.showErrors(errors, ['Domain access was declined; the source cannot work without it']);
          return;
        }
        // Editing under a new id: drop the old registration + stored spec
        if (editing && existing!.id !== spec.id) {
          await userSourcesManager.remove(existing!.id);
          sourceRegistry.unregisterUserSource(existing!.id);
        }
        await userSourcesManager.save(spec);
        sourceRegistry.unregisterUserSource(spec.id);
        sourceRegistry.registerUserSource(spec);
        if (spec.referer) await setRefererRule(spec.id, spec.baseUrl, spec.referer, spec.imageHosts ?? []);
        showDashToast(editing ? `${spec.name} updated` : `${spec.name} added`);
        close();
        if (this.host) void this.mount(this.host);
      } catch (error) {
        this.showErrors(errors, [(error as Error).message]);
      }
    });
  }

  private showHelpModal(): void {
    const { overlay } = buildModal(
      'Adding a source',
      `
      <div class="crd-help-body">
        <p>A source is a small JSON "recipe" that tells the reader how to search a manga site and open its chapters. You don't need to write it yourself.</p>

        <div class="crd-help-section">
          <h4>Let an AI write it for you</h4>
          <ol class="crd-help-steps">
            <li>Copy the prompt below.</li>
            <li>Paste it into ChatGPT, Claude, Gemini, or any AI chat, and swap the placeholder for your site's address.</li>
            <li>Copy the JSON it gives back into the editor here, then hit <b>Validate &amp; add</b>.</li>
            <li>Press the flask icon on your new source to test it. If a step shows red, paste that exact error back to the AI and ask it to fix the spec. A round or two usually gets everything green.</li>
          </ol>
          <div class="crd-claude-row">
            <a class="crd-claude-link" id="crd-claude-link" target="_blank" rel="noopener"><img src="assets/icons/claude-logo.png" alt="">claude it
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/></svg>
            </a>
          </div>
          <button class="crd-btn crd-help-copy" id="crd-help-copy">Copy AI prompt</button>
        </div>

        <div class="crd-help-section">
          <h4>Good to know</h4>
          <ul class="crd-help-steps">
            <li>This works for most manga sites. Sites that need to run code in your browser (heavy anti-bot protection, scrambled images) can't be added this way.</li>
            <li>If pages fail with an access error, the usual fix is setting <b>imageHosts</b> to <b>["https://*/*"]</b> in the spec; the AI prompt explains this too.</li>
            <li>You can share a working source with friends: edit it and use Download JSON.</li>
          </ul>
        </div>
      </div>
      `
    );

    const copyBtn = overlay.querySelector<HTMLButtonElement>('#crd-help-copy');
    copyBtn?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(SPEC_AI_PROMPT);
        copyBtn.textContent = '✓ Copied, paste it into your AI chat';
        setTimeout(() => { copyBtn.textContent = 'Copy AI prompt'; }, 2200);
      } catch {
        showDashToast('Copy failed, select the text manually');
      }
    });

    // claude.ai/new?q= prefills a fresh chat with the prompt; copy to the
    // clipboard too as a paste fallback in case the URL gets trimmed
    const claudeLink = overlay.querySelector<HTMLAnchorElement>('#crd-claude-link');
    if (claudeLink) {
      claudeLink.href = `https://claude.ai/new?q=${encodeURIComponent(SPEC_AI_PROMPT)}`;
      claudeLink.addEventListener('click', () => {
        void navigator.clipboard.writeText(SPEC_AI_PROMPT).catch(() => { /* prefill still works */ });
      });
    }
  }

  private async editUserSource(id: string): Promise<void> {
    const spec = await userSourcesManager.get(id);
    if (spec) this.openSpecModal(spec);
  }

  private downloadText(text: string, filename: string): void {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private showErrors(el: HTMLElement, problems: string[]): void {
    el.hidden = false;
    el.innerHTML = problems.map((p) => `<div>• ${escapeHtml(p)}</div>`).join('');
  }

  private async removeUserSource(id: string, name: string, list: HTMLElement): Promise<void> {
    if (!confirm(`Remove ${name}? Manga linked to it will need a different source.`)) return;
    await userSourcesManager.remove(id);
    sourceRegistry.unregisterUserSource(id);
    try { await setRefererRule(id, 'https://unused.invalid', null); } catch { /* no rule existed */ }
    showDashToast(`${name} removed`);
    this.renderList(list);
  }

  // ── Test harness ──────────────────────────────────────────────────────────

  private async showTestModal(sourceId: string): Promise<void> {
    const spec = await userSourcesManager.get(sourceId);
    if (!spec) return;

    const { overlay } = buildModal(
      `Test ${escapeHtml(spec.name)}`,
      `
        <p class="crd-panel-desc">Runs search → details → chapters → pages against the live site (bypasses caches).</p>
        <div class="crd-modal-row">
          <input type="text" class="crd-num crd-modal-url" id="crd-test-q" placeholder="Search query" value="the">
          <button class="crd-btn" id="crd-test-run">Run</button>
        </div>
        <div class="crd-test-log" id="crd-test-log"></div>
      `
    );
    overlay.querySelector('#crd-test-run')?.addEventListener('click', () => {
      const query = overlay.querySelector<HTMLInputElement>('#crd-test-q')!.value.trim();
      void this.runTest(spec, query, overlay.querySelector<HTMLElement>('#crd-test-log')!);
    });
  }

  private async runTest(spec: SourceSpecV1, query: string, log: HTMLElement): Promise<void> {
    log.innerHTML = '';
    const line = (ok: boolean | null, step: string, parts: string[]) => {
      const el = document.createElement('div');
      el.className = `crd-test-line${ok === null ? '' : ok ? ' ok' : ' fail'}`;
      el.innerHTML = `
        <span class="crd-test-status">${ok === null ? '…' : ok ? '✓' : '✗'}</span>
        <span class="crd-test-step">${escapeHtml(step)}</span>
        <span class="crd-test-msg">${parts.map((p) => escapeHtml(p)).join('<span class="crd-test-sep">·</span>')}</span>
      `;
      log.appendChild(el);
      return el;
    };

    let currentStep = 'search';
    const source = new DeclarativeSource(spec);
    try {
      const searching = line(null, 'search', [`running "${query}"`]);
      const results = await source.search(query);
      searching.remove();
      line(results.length > 0, 'search', [
        `${results.length} results`,
        ...(results[0] ? [`first "${results[0].title}"`, `slug ${results[0].slug}`] : []),
      ]);
      if (!results.length) return;

      currentStep = 'details';
      const target = results[0];
      const details = await source.getMangaDetails(target.slug);
      line(!!details.title, 'details', [
        `"${details.title}"`,
        `cover ${details.thumbnailUrl ? 'yes' : 'MISSING'}`,
        `status ${details.status || 'unknown'}`,
      ]);

      currentStep = 'chapters';
      const chapters = await source.getChapterList(target.slug);
      const first = chapters[chapters.length - 1] ?? chapters[0];
      line(chapters.length > 0, 'chapters', [
        `${chapters.length} chapters`,
        ...(first ? [
          `#${first.number} "${first.title}"`,
          `slug ${first.slug}`,
          first.dateUpload ? new Date(first.dateUpload).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'date unparsed',
        ] : []),
      ]);
      if (!chapters.length) return;

      currentStep = 'pages';
      const pages = await source.getChapterPages(target.slug, first.slug);
      line(pages.length > 0, 'pages', [
        `${pages.length} pages`,
        `first ${pages[0]?.url.slice(0, 72) ?? '-'}`,
      ]);

      // Images on an origin we lack permission for get CORS-blocked at read
      // time; catch that here where the spec author can still fix it
      if (pages[0]) {
        const imageOrigin = new URL(pages[0].url).origin + '/*';
        const granted = await chrome.permissions.contains({ origins: [imageOrigin] });
        if (!granted) {
          line(false, 'access', [
            `no permission for image host ${imageOrigin}`,
            'add it to "imageHosts" in the spec, then save to be prompted',
          ]);
          return;
        }

        currentStep = 'image';
        const imageResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: pages[0].url }, (response) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(response as { ok: boolean; error?: string });
          });
        });
        if (!imageResult.ok) {
          line(false, 'image', [
            imageResult.error || 'first page image failed',
            spec.referer && (spec.imageHosts ?? []).some((host) => host.includes('*') && host.includes('://*'))
              ? 'if this CDN needs a Referer, replace the all-host imageHosts wildcard with the concrete CDN host'
              : 'check imageHosts and referer',
          ]);
          return;
        }
        line(true, 'image', ['first page image fetched']);
      }
      line(true, 'done', ['all steps passed']);
    } catch (error) {
      line(false, currentStep, [(error as Error).message]);
    }
  }

  // ── Domain override / ordering ────────────────────────────────────────────

  private async editDomain(sourceId: string, current: string, list: HTMLElement): Promise<void> {
    const input = prompt(
      'Custom domain for this source (the site moved?).\nLeave empty to restore the default.\nNote: sources with a separate API domain may only partially follow this.',
      current
    );
    if (input === null) return;
    const trimmed = input.trim();
    try {
      if (trimmed && !/^https?:\/\//.test(trimmed)) throw new Error('Must start with http(s)://');
      if (trimmed && !await ensureOriginPermissions([trimmed])) throw new Error('Permission declined');
      await sourceConfigManager.setBaseUrlOverride(sourceId, trimmed || null);
      await sourceRegistry.refreshConfig();
      showDashToast(trimmed ? 'Custom domain set' : 'Domain restored to default');
      this.renderList(list);
    } catch (error) {
      showDashToast(`Domain not changed: ${(error as Error).message}`);
    }
  }

  private readonly onDragOver = (e: DragEvent): void => {
    if (!this.dragEl) return;
    e.preventDefault();
    const list = e.currentTarget as HTMLElement;
    const after = this.rowAfterPointer(list, e.clientY);
    if (after === null) {
      list.appendChild(this.dragEl);
    } else if (after !== this.dragEl) {
      list.insertBefore(this.dragEl, after);
    }
  };

  private rowAfterPointer(list: HTMLElement, y: number): HTMLElement | null {
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.crd-src-row:not(.crd-dragging)'));
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return row;
    }
    return null;
  }

  private async persistOrder(list: HTMLElement): Promise<void> {
    const order = Array.from(list.querySelectorAll<HTMLElement>('.crd-src-row'))
      .map((row) => row.dataset.id!)
      .filter(Boolean);
    await sourceConfigManager.setOrder(order);
    showDashToast('Source priority saved');
    this.renderList(list);
  }
}
