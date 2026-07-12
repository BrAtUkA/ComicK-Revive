import { sourceRegistry, createEngineSource } from '@/sources';
import type { MangaSource } from '@/sources';
import { SourceError } from '@/sources/Source.interface';
import { DeclarativeSource } from '@/sources/spec/DeclarativeSource';
import { validateSourceSpec, type SourceSpecV1 } from '@/sources/spec/SourceSpec';
import { CATALOG, getCatalogPreset, type CatalogPreset } from '@/sources/catalog/presets';
import { sourceConfigManager, userSourcesManager, sourceCatalogManager, settingsManager } from '@/core';
import { fetchWithCors } from '@/utils/fetchWithCors';
import type { DashboardTab } from '../Dashboard';
import { showDashToast } from '../Dashboard';
import { buildModal } from '../modal';
import { ensureOriginPermissions, setRefererRule, originPatternsFor } from '../sourcePermissions';
import { createJsonEditor } from '../jsonEditor';
import { SPEC_AI_PROMPT } from '../spec-ai-prompt';
import { escapeHtml } from '@/shared/fmt';

interface CheckResult {
  status: 'ok' | 'partial' | 'blocked' | 'fail';
  note?: string;
  /** Set on partial results: the image CDN origin that needs a permission grant. */
  imageOrigin?: string;
}

const GRIP_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;
const FLASK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v6L4.5 18.5A2 2 0 0 0 6.24 21.5h11.52a2 2 0 0 0 1.74-3L14 8V2"/><line x1="8.5" y1="2" x2="15.5" y2="2"/><line x1="7" y1="14" x2="17" y2="14"/></svg>`;
const HELP_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><line x1="12" y1="17.5" x2="12.01" y2="17.5"/></svg>`;
const PENCIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`;
const DOWNLOAD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const TEST_OK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
const TEST_FAIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

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
  // Session-scoped catalog check verdicts: survive closing/reopening the
  // modal, deliberately NOT persisted across sessions — cf_clearance expires
  // (typically ~30 min), so a stale "blocked"/"works" chip would lie
  private catalogResults = new Map<string, CheckResult>();

  async mount(host: HTMLElement): Promise<void> {
    this.host = host;
    await sourceRegistry.refreshConfig();
    await sourceRegistry.loadUserSources();
    await sourceRegistry.loadCatalogSources();

    host.innerHTML = `
      <div class="crd-content">
        <h1 class="crd-tab-head">Sources</h1>
        <p class="crd-tab-sub">Drag to set priority. Search All queries sources top to bottom.</p>
        <div class="crd-src-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>Disabling a source hides it from new searches. Manga already linked to it keep working. Catalog sources only get access to their own site, granted when you enable them.</span>
        </div>
        <div id="crd-src-list"></div>
        <div class="crd-btn-row">
          <button class="crd-btn crd-btn-primary" id="crd-src-catalog">Browse catalog</button>
          <button class="crd-btn" id="crd-src-add">Add source</button>
        </div>
      </div>
    `;

    host.querySelector('#crd-src-add')?.addEventListener('click', () => void this.openSpecModal());
    host.querySelector('#crd-src-catalog')?.addEventListener('click', () => void this.openCatalogModal());
    this.renderList(host.querySelector<HTMLElement>('#crd-src-list')!);
  }

  private renderList(list: HTMLElement): void {
    list.innerHTML = '';
    const sources = sourceRegistry.getAll({ includeDisabled: true });

    for (const source of sources) {
      const enabled = sourceRegistry.isEnabled(source.id);
      const isUser = sourceRegistry.isUserSource(source.id);
      const isCatalog = sourceRegistry.isCatalogSource(source.id);
      const chip = isUser
        ? '<span class="crd-chip">user</span>'
        : isCatalog
          ? '<span class="crd-chip catalog">catalog</span>'
          : '<span class="crd-chip builtin">built-in</span>';
      const row = document.createElement('div');
      row.className = `crd-src-row${enabled ? '' : ' off'}`;
      row.dataset.id = source.id;
      row.draggable = true;
      const iconUrl = (source as { iconUrl?: string }).iconUrl;
      row.innerHTML = `
        <span class="crd-src-handle" title="Drag to reorder">${GRIP_SVG}</span>
        <div class="crd-src-icon">${iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="">` : escapeHtml(source.name.slice(0, 1))}</div>
        <div class="crd-src-body">
          <div class="crd-src-name"><span class="crd-src-name-text">${escapeHtml(source.name)}</span>${chip}</div>
          <div class="crd-src-url">
            <a class="crd-src-url-link" href="${escapeHtml(source.baseUrl)}" target="_blank" rel="noopener">${escapeHtml(source.baseUrl.replace(/^https?:\/\//, ''))}</a>
            ${isUser || isCatalog ? '' : '<a class="crd-src-domain-edit" title="Use a custom domain (when the site moves)">domain</a>'}
          </div>
        </div>
        <span class="crd-src-actions">
          <button class="crd-icon-btn" data-act="test" title="Test against the live site">${FLASK_SVG}</button>
          ${isUser ? `
            <button class="crd-icon-btn" data-act="edit" title="Edit spec">${PENCIL_SVG}</button>
            <button class="crd-icon-btn danger" data-act="remove" title="Remove source">${TRASH_SVG}</button>
          ` : ''}
          ${isCatalog ? `
            <button class="crd-icon-btn danger" data-act="catalog-remove" title="Remove (revokes site access)">${TRASH_SVG}</button>
          ` : ''}
        </span>
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
      // Dead icon URL: fall back to the letter instead of a broken-image glyph
      img?.addEventListener('error', () => {
        const box = img.parentElement;
        if (box) {
          img.remove();
          box.classList.remove('wide');
          box.textContent = source.name.slice(0, 1);
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
      row.querySelector('[data-act="catalog-remove"]')?.addEventListener('click', () => void this.disableCatalogSource(source.id, source.name, list));
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

  private async openSpecModal(existing?: SourceSpecV1): Promise<void> {
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
          <button class="crd-btn crd-btn-primary" id="crd-imp-add">${editing ? 'Save changes' : 'Validate & add'}</button>
          ${editing ? `<button class="crd-btn" id="crd-imp-download">${DOWNLOAD_SVG}<span>Download JSON</span></button>` : ''}
        </div>
      `,
      {
        large: true,
        headerActions: `<button class="crd-btn crd-btn-small crd-help-pill" id="crd-imp-help-btn">${HELP_SVG}&nbsp;Help</button>`,
      }
    );

    const editor = await createJsonEditor(existing ? JSON.stringify(existing, null, 2) : '');
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
    if (spec) void this.openSpecModal(spec);
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

  // ── Catalog ───────────────────────────────────────────────────────────────

  private async openCatalogModal(): Promise<void> {
    const settings = await settingsManager.load();
    // Most reference sources carry a conservative mature flag, so the hidden
    // majority must be visible in the count AND toggleable right here — the
    // Settings-tab toggle alone proved undiscoverable
    let showNsfw = settings.showNsfwSources;
    const computeVisible = () => CATALOG
      .filter((p) => showNsfw || !p.nsfw)
      .sort((a, b) => a.name.localeCompare(b.name));
    let visible = computeVisible();
    const countText = (shown: number): string => {
      const hiddenNsfw = CATALOG.length - visible.length;
      const hiddenNote = hiddenNsfw > 0 ? ` · ${hiddenNsfw} hidden by the 18+ filter` : '';
      return `${shown} of ${visible.length} sources · ${enabledIds.size} enabled${hiddenNote}`;
    };

    const { overlay } = buildModal(
      'Source catalog',
      `
        <p class="crd-panel-desc">Built-in sources you can switch on. Enabling one asks for access to that site only, nothing else.</p>
        <div class="crd-modal-row">
          <input type="text" class="crd-num crd-modal-url" id="crd-cat-q" placeholder="Filter by name or domain" spellcheck="false" autocomplete="off">
          <button class="crd-btn" id="crd-cat-check" title="Run the pipeline against every enabled source">Check enabled</button>
          <button class="crd-btn" id="crd-cat-testall" title="One access prompt for every listed site, full pipeline against each, then access is revoked for sources you keep disabled">Test all</button>
        </div>
        <div class="crd-cat-count-row">
          <span class="crd-cat-count" id="crd-cat-count"></span>
          <span class="crd-cat-nsfw" title="List adult sites in the catalog (same setting as Settings → Behavior)">
            <span>Show 18+ sources</span>
            <label class="crd-toggle"><input type="checkbox" id="crd-cat-nsfw-toggle" ${showNsfw ? 'checked' : ''}><i></i></label>
          </span>
        </div>
        <div class="crd-cat-progress" id="crd-cat-progress" hidden>
          <div class="crd-cat-bar" id="crd-cat-bar">
            <span class="seg ok"></span><span class="seg partial"></span><span class="seg blocked"></span><span class="seg fail"></span><span class="seg left"></span>
          </div>
          <span class="crd-cat-progress-text" id="crd-cat-progress-text"></span>
          <button class="crd-btn crd-btn-small" id="crd-cat-copy" disabled title="Copy the full run report (verdicts, notes, preset + learned config) for a bug report or to paste to an AI">Copy report</button>
        </div>
        <div class="crd-cat-list" id="crd-cat-list"></div>
      `,
      { tall: true }
    );
    const listEl = overlay.querySelector<HTMLElement>('#crd-cat-list')!;
    const countEl = overlay.querySelector<HTMLElement>('#crd-cat-count')!;
    const q = overlay.querySelector<HTMLInputElement>('#crd-cat-q')!;
    const checkBtn = overlay.querySelector<HTMLButtonElement>('#crd-cat-check')!;
    const testAllBtn = overlay.querySelector<HTMLButtonElement>('#crd-cat-testall')!;
    const nsfwToggle = overlay.querySelector<HTMLInputElement>('#crd-cat-nsfw-toggle')!;
    const progressUi = {
      wrap: overlay.querySelector<HTMLElement>('#crd-cat-progress')!,
      bar: overlay.querySelector<HTMLElement>('#crd-cat-bar')!,
      text: overlay.querySelector<HTMLElement>('#crd-cat-progress-text')!,
      copyBtn: overlay.querySelector<HTMLButtonElement>('#crd-cat-copy')!,
    };

    const enabledIds = new Set(await sourceCatalogManager.getEnabledIds());
    const rowStatus = new Map<string, HTMLElement>();
    const lastResult = this.catalogResults;
    const paint = (id: string, res: CheckResult) => {
      lastResult.set(id, res);
      this.paintStatus(rowStatus.get(id), res);
    };
    const markRunning = (id: string, text: string) => {
      const st = rowStatus.get(id);
      if (st) { st.className = 'crd-cat-status running'; st.textContent = text; st.title = ''; }
    };

    // Grant the source's image CDN origin (partial chip click), remember it,
    // extend the referer rule, re-test. permissions.request MUST be the first
    // await: it needs the click's user gesture.
    const grantImageAccess = async (preset: CatalogPreset, imageOrigin: string): Promise<void> => {
      let granted = false;
      try {
        // Domain scope so the CDN's own redirects (apex⇄www, sibling hosts)
        // stay covered, same reasoning as the base-site grant
        granted = await chrome.permissions.request({ origins: originPatternsFor(imageOrigin) });
      } catch (error) {
        console.warn('[SourcesTab] Image origin request failed:', error);
      }
      if (!granted) {
        showDashToast('Image host access declined');
        return;
      }
      await sourceCatalogManager.patchLearned(preset.id, { imageHosts: [imageOrigin] });
      if (enabledIds.has(preset.id)) {
        try {
          const learned = await sourceCatalogManager.getLearned(preset.id);
          await setRefererRule(
            preset.id, preset.baseUrl, preset.overrides?.referer ?? preset.baseUrl + '/',
            [...(preset.overrides?.imageHosts ?? []), ...(learned.imageHosts ?? [])]
          );
        } catch (error) {
          console.warn('[SourcesTab] Referer rule update failed:', error);
        }
      }
      markRunning(preset.id, 're-testing…');
      const source = sourceRegistry.getRaw(preset.id) ?? createEngineSource(preset);
      paint(preset.id, await this.quickCheck(source));
    };

    const render = () => {
      const query = q.value.trim().toLowerCase();
      const shown = query
        ? visible.filter((p) => p.name.toLowerCase().includes(query) || p.baseUrl.toLowerCase().includes(query))
        : visible;
      countEl.textContent = countText(shown.length);
      rowStatus.clear();
      listEl.innerHTML = '';
      for (const preset of shown) {
        listEl.appendChild(buildRow(preset));
      }
      if (shown.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'crd-cat-empty';
        empty.textContent = 'Nothing matches that filter.';
        listEl.appendChild(empty);
      }
    };

    const buildRow = (preset: CatalogPreset): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'crd-cat-row';
      const domain = preset.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      row.innerHTML = `
        <div class="crd-cat-icon">${preset.iconUrl ? `<img src="${escapeHtml(preset.iconUrl)}" alt="">` : escapeHtml(preset.name.slice(0, 1))}</div>
        <div class="crd-cat-body">
          <div class="crd-cat-name">${escapeHtml(preset.name)}${preset.nsfw ? '<span class="crd-chip nsfw">18+</span>' : ''}</div>
          <div class="crd-cat-domain">${escapeHtml(domain)} · ${escapeHtml(preset.engine)}</div>
        </div>
      `;
      // Letter fallback when the bundled icon is missing (inline onerror is
      // barred by the extension CSP, so wire it here)
      const iconImg = row.querySelector<HTMLImageElement>('.crd-cat-icon img');
      iconImg?.addEventListener('error', () => {
        iconImg.parentElement!.textContent = preset.name.slice(0, 1);
      }, { once: true });
      const status = document.createElement('span');
      status.className = 'crd-cat-status';
      row.appendChild(status);
      rowStatus.set(preset.id, status);
      // Restore prior verdict when the list re-renders (e.g. after filtering)
      const prior = lastResult.get(preset.id);
      if (prior) this.paintStatus(status, prior);
      // Actionable chip: partial → one-click image-host grant. Blocked chips
      // are informational only (the bot-wall unlock flow is shelved; see
      // docs/bot-wall-unlock-and-cors.md)
      status.addEventListener('click', () => {
        const last = lastResult.get(preset.id);
        if (last?.status === 'partial' && last.imageOrigin) void grantImageAccess(preset, last.imageOrigin);
      });
      const btn = document.createElement('button');
      const setBtn = () => {
        const on = enabledIds.has(preset.id);
        btn.className = on ? 'crd-btn crd-btn-small' : 'crd-btn crd-btn-small crd-btn-primary';
        btn.textContent = on ? 'Remove' : 'Enable';
      };
      setBtn();
      btn.addEventListener('click', () => void (async () => {
        btn.disabled = true;
        try {
          if (enabledIds.has(preset.id)) {
            await this.catalogDisable(preset.id);
            enabledIds.delete(preset.id);
            showDashToast(`${preset.name} removed`);
          } else {
            const ok = await this.catalogEnable(preset);
            if (ok) {
              enabledIds.add(preset.id);
              showDashToast(`${preset.name} enabled`);
            }
          }
        } finally {
          btn.disabled = false;
          setBtn();
          countEl.textContent = countText(listEl.children.length);
          const mainList = this.host?.querySelector<HTMLElement>('#crd-src-list');
          if (mainList) this.renderList(mainList);
        }
      })());
      row.appendChild(btn);
      return row;
    };

    let qTimer: ReturnType<typeof setTimeout> | null = null;
    q.addEventListener('input', () => {
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(render, 120);
    });

    // Same setting as Settings → Behavior, editable where the need shows up
    nsfwToggle.addEventListener('change', () => void (async () => {
      showNsfw = nsfwToggle.checked;
      await settingsManager.update({ showNsfwSources: showNsfw });
      visible = computeVisible();
      render();
    })());

    // Batch ground truth over the ENABLED sources only
    checkBtn.addEventListener('click', () => void (async () => {
      const enabled = visible.filter((p) => enabledIds.has(p.id));
      if (enabled.length === 0) {
        showDashToast('Enable a source first, then check');
        return;
      }
      // Heal stale grants: sources enabled before the domain-wide patterns
      // existed hold only their exact origin, so any apex⇄www redirect kills
      // the fetch with "Failed to fetch". One combined request (this click's
      // gesture) upgrades them all; declining just runs the checks as-is.
      await ensureOriginPermissions([
        ...enabled.map((p) => p.baseUrl),
        ...enabled.flatMap((p) => p.overrides?.imageHosts ?? []),
      ]);
      checkBtn.disabled = true;
      let okCount = 0;
      for (const preset of enabled) {
        markRunning(preset.id, 'checking…');
        const raw = sourceRegistry.getRaw(preset.id);
        const res: CheckResult = raw ? await this.quickCheck(raw) : { status: 'fail', note: 'not registered' };
        paint(preset.id, res);
        if (res.status === 'ok' || res.status === 'partial') okCount++;
      }
      checkBtn.disabled = false;
      showDashToast(`${okCount} of ${enabled.length} enabled sources working`);
    })());

    // Everything we can do in one click: temporary access to every listed
    // site (ONE prompt), full pipeline against each, then revoke access for
    // sources that stay disabled
    testAllBtn.addEventListener('click', () => void this.runCatalogTestAll(visible, enabledIds, testAllBtn, markRunning, paint, progressUi));

    render();
  }

  private async runCatalogTestAll(
    visible: CatalogPreset[],
    enabledIds: Set<string>,
    btn: HTMLButtonElement,
    markRunning: (id: string, text: string) => void,
    paint: (id: string, res: CheckResult) => void,
    progress?: { wrap: HTMLElement; bar: HTMLElement; text: HTMLElement; copyBtn: HTMLButtonElement }
  ): Promise<void> {
    const origins = [
      ...visible.map((p) => p.baseUrl),
      ...visible.flatMap((p) => p.overrides?.imageHosts ?? []),
    ];
    if (!await ensureOriginPermissions(origins)) {
      showDashToast('Access declined; nothing was tested');
      return;
    }

    // Not-enabled sources have no Referer DNR rule (installed at enable
    // time); give every tested site a session rule so checks run with the
    // same headers an enabled source would send. The cleanup below removes
    // them again for sources that stay disabled.
    for (const preset of visible) {
      if (enabledIds.has(preset.id)) continue;
      try {
        await setRefererRule(preset.id, preset.baseUrl,
          preset.overrides?.referer ?? preset.baseUrl + '/', preset.overrides?.imageHosts ?? []);
      } catch { /* best effort */ }
    }

    btn.disabled = true;
    const label = btn.textContent;
    let done = 0;
    const counts: Record<CheckResult['status'], number> = { ok: 0, partial: 0, blocked: 0, fail: 0 };
    const queue = [...visible];
    const runResults = new Map<string, CheckResult>();

    // Live progress strip: segmented bar (work/partial/blocked/failed/left)
    // + counts, out of the way above the list. Copy report arms on finish.
    const paintProgress = () => {
      if (!progress) return;
      progress.wrap.hidden = false;
      const left = visible.length - done;
      const seg = (cls: string, n: number) => {
        const el = progress.bar.querySelector<HTMLElement>(`.seg.${cls}`);
        if (el) el.style.flexGrow = String(n);
      };
      seg('ok', counts.ok); seg('partial', counts.partial);
      seg('blocked', counts.blocked); seg('fail', counts.fail); seg('left', left);
      progress.text.textContent =
        `${counts.ok} work · ${counts.partial} partial · ${counts.blocked} blocked · ${counts.fail} failed${left > 0 ? ` · ${left} left` : ''}`;
    };
    if (progress) {
      progress.copyBtn.disabled = true;
      paintProgress();
    }

    const worker = async () => {
      while (queue.length) {
        if (!btn.isConnected) return; // modal closed mid-run
        const preset = queue.shift()!;
        markRunning(preset.id, 'testing…');
        // Enabled sources use their live instance; the rest get a detached
        // engine instance that is never registered
        const source = sourceRegistry.getRaw(preset.id) ?? createEngineSource(preset);
        const res = await this.quickCheck(source);
        paint(preset.id, res);
        runResults.set(preset.id, res);
        counts[res.status]++;
        done++;
        btn.textContent = `Testing ${done}/${visible.length}`;
        paintProgress();
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    btn.textContent = label;
    btn.disabled = false;
    const blockedNote = counts.blocked ? `, ${counts.blocked} blocked by bot checks` : '';
    showDashToast(`${counts.ok} work, ${counts.partial} partial${blockedNote}, ${counts.fail} failed`);

    if (progress && runResults.size > 0) {
      const report = await this.composeCatalogReport(visible, enabledIds, runResults, counts);
      progress.copyBtn.disabled = false;
      progress.copyBtn.onclick = () => {
        void navigator.clipboard.writeText(report).then(() => showDashToast('Report copied'));
      };
    }

    // Honesty cleanup: revoke the temporary origins and session referer rules
    // for every source the user did not enable
    for (const preset of visible) {
      if (enabledIds.has(preset.id)) continue;
      try { await setRefererRule(preset.id, preset.baseUrl, null); } catch { /* none existed */ }
      try {
        const origin = new URL(preset.baseUrl).origin;
        const keptByEnabled = CATALOG.some((p) =>
          enabledIds.has(p.id) && new URL(p.baseUrl).origin === origin);
        if (!keptByEnabled) {
          await chrome.permissions.remove({ origins: originPatternsFor(preset.baseUrl) });
        }
      } catch { /* best effort */ }
    }
  }

  /**
   * Plaintext report of a Test all run, built to be pasted into a GitHub
   * issue or an AI chat: environment, summary, every non-working source with
   * its full verdict note and effective config (preset overrides + learned
   * facts), then the working ones as one-liners.
   */
  private async composeCatalogReport(
    visible: CatalogPreset[],
    enabledIds: Set<string>,
    results: Map<string, CheckResult>,
    counts: Record<CheckResult['status'], number>
  ): Promise<string> {
    const manifest = chrome.runtime.getManifest();
    const learned = new Map(await Promise.all(
      visible.map(async (p) => [p.id, await sourceCatalogManager.getLearned(p.id)] as const)
    ));

    const lines: string[] = [
      'ComicK Revive catalog "Test all" report',
      `date: ${new Date().toISOString()}`,
      `extension: v${manifest.version}`,
      `browser: ${navigator.userAgent}`,
      `catalog: ${CATALOG.length} presets · ${results.size} tested${visible.length < CATALOG.length ? ' (18+ hidden)' : ''} · ${enabledIds.size} enabled`,
      `summary: ${counts.ok} work · ${counts.partial} partial · ${counts.blocked} blocked · ${counts.fail} failed`,
      '',
    ];

    const headline = (p: CatalogPreset, status: string) =>
      `${status.toUpperCase().padEnd(8)}${p.id.padEnd(24)}${p.baseUrl}${enabledIds.has(p.id) ? '  [enabled]' : ''}`;
    const configBits = (o?: { mangaPath?: string; loadMore?: boolean; referer?: string; imageHosts?: string[] }) => [
      o?.mangaPath ? `mangaPath=${o.mangaPath}` : '',
      o?.loadMore !== undefined ? `loadMore=${o.loadMore}` : '',
      o?.referer ? `referer=${o.referer}` : '',
      o?.imageHosts?.length ? `imageHosts=${o.imageHosts.join(',')}` : '',
    ].filter(Boolean).join(' ');

    for (const status of ['fail', 'blocked', 'partial', 'ok'] as const) {
      const group = visible.filter((p) => results.get(p.id)?.status === status);
      if (group.length === 0) continue;
      for (const p of group) {
        const res = results.get(p.id)!;
        lines.push(headline(p, status));
        if (status !== 'ok') {
          if (res.note) lines.push(`        note: ${res.note}`);
          if (res.imageOrigin) lines.push(`        imageOrigin: ${res.imageOrigin}`);
          const preset = configBits(p.overrides);
          if (preset) lines.push(`        preset: ${preset}`);
          const learnt = configBits(learned.get(p.id));
          if (learnt) lines.push(`        learned: ${learnt}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n').trimEnd() + '\n';
  }

  /**
   * Listing (or search) → chapters → pages → first page image, against the
   * live site with browser TLS and the user's cookies; first failure wins.
   * The popular listing is the primary probe: it exists on every healthy
   * Madara site, while a stopword search legitimately returns nothing on
   * many of them. 'partial' = scraping works but the first image didn't
   * (usually a Referer-gated CDN; the chip click grants its host).
   * 'blocked' = a bot wall; automated unlock is shelved, so this is
   * informational (docs/bot-wall-unlock-and-cors.md has the full story).
   */
  private async quickCheck(source: MangaSource): Promise<CheckResult> {
    try {
      let results = source.getPopular ? await source.getPopular(1) : [];
      if (results.length === 0) results = await source.search('the');
      if (results.length === 0) return { status: 'fail', note: 'listing and search both returned nothing' };
      const chapters = await source.getChapterList(results[0].slug);
      if (chapters.length === 0) return { status: 'fail', note: 'no chapters found' };
      const pages = await source.getChapterPages(results[0].slug, chapters[0].slug);
      if (pages.length === 0) return { status: 'fail', note: 'no pages found' };

      const imageOrigin = new URL(pages[0].url).origin;
      const imageHost = new URL(pages[0].url).host;
      // Fetch the image WITHOUT credentials: pages are not auth-gated, and a
      // credentialed request forbids the wildcard `ACAO: *` that image CDNs
      // universally return, so `credentials:'include'` here fails on every
      // foreign CDN. With omit, a foreign CDN loads under CORS even without a
      // host grant; only a Referer-gated CDN still needs the one-click grant.
      const img = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: pages[0].url }, (response) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response as { ok: boolean; error?: string });
        });
      });
      if (!img.ok) {
        // HTTP 5xx means the CDN answered and failed on its own end (526 =
        // its origin's SSL is broken); no grant or Referer helps, so don't
        // offer one — omitting imageOrigin keeps the chip informational
        if (/^HTTP 5\d\d$/.test(img.error ?? '')) {
          return {
            status: 'partial',
            note: `reads fine, but the image CDN (${imageHost}) is failing on its own end: ${img.error}. Nothing to grant; only the site can fix this`,
          };
        }
        return {
          status: 'partial',
          note: `reads fine, but the first image (on ${imageHost}) failed: ${img.error ?? 'fetch error'}. Granting access to that host adds a Referer that usually fixes it`,
          imageOrigin,
        };
      }
      return { status: 'ok' };
    } catch (error) {
      if (error instanceof SourceError && error.code === 'BLOCKED') {
        return { status: 'blocked', note: error.message };
      }
      return { status: 'fail', note: (error as Error).message };
    }
  }

  private paintStatus(el: HTMLElement | undefined, res: CheckResult): void {
    if (!el) return;
    const label: Record<CheckResult['status'], string> = {
      ok: 'works', partial: 'partial', blocked: 'blocked', fail: 'failed',
    };
    el.className = `crd-cat-status ${res.status}`;
    el.textContent = label[res.status];
    el.title = res.status === 'blocked'
      ? `${res.note ?? ''}\nThis site runs a bot check the extension cannot pass automatically yet.`
      : res.status === 'partial' && res.imageOrigin
        ? `${res.note ?? ''}\n(click to grant image access)`
        : (res.note ?? '');
  }

  /** Request the site's origin, then persist + register. Returns false when declined. */
  private async catalogEnable(preset: CatalogPreset): Promise<boolean> {
    if (sourceRegistry.has(preset.id) && !sourceRegistry.isCatalogSource(preset.id)) {
      showDashToast(`A source with id "${preset.id}" already exists`);
      return false;
    }
    const imageHosts = preset.overrides?.imageHosts ?? [];
    if (!await ensureOriginPermissions([preset.baseUrl, ...imageHosts])) {
      showDashToast('Site access declined; source not enabled');
      return false;
    }
    await sourceCatalogManager.enable(preset.id);
    if (!sourceRegistry.isCatalogSource(preset.id)) {
      sourceRegistry.registerCatalogSource(preset);
    }
    try {
      // Learned image origins (from a past partial-chip grant) keep their
      // permission across sessions; fold them into the rule alongside the
      // preset's static hosts
      const learned = await sourceCatalogManager.getLearned(preset.id);
      const allHosts = [...new Set([...imageHosts, ...(learned.imageHosts ?? [])])];
      await setRefererRule(preset.id, preset.baseUrl, preset.overrides?.referer ?? preset.baseUrl + '/', allHosts);
    } catch (error) {
      console.warn('[SourcesTab] Referer rule for catalog source failed:', error);
    }
    await this.applyPresetCookies(preset);
    return true;
  }

  /** Set age-gate / preference cookies a preset needs (best effort). */
  private async applyPresetCookies(preset: CatalogPreset): Promise<void> {
    const cookies = preset.overrides?.cookies;
    if (!cookies || Object.keys(cookies).length === 0) return;
    try {
      if (!await chrome.permissions.request({ permissions: ['cookies'] })) {
        showDashToast(`${preset.name} enabled, but mature titles stay hidden without the cookies permission`);
        return;
      }
      for (const [name, value] of Object.entries(cookies)) {
        await chrome.cookies.set({ url: preset.baseUrl, name, value });
      }
    } catch (error) {
      console.warn('[SourcesTab] Preset cookies failed:', error);
    }
  }

  private async catalogDisable(id: string): Promise<void> {
    const preset = getCatalogPreset(id);
    // Capture learned image origins before disable() clears them (a remove
    // is a reset), so their permissions get revoked too
    const learnedHosts = (await sourceCatalogManager.getLearned(id)).imageHosts ?? [];
    await sourceCatalogManager.disable(id);
    sourceRegistry.unregisterCatalogSource(id);
    try { await setRefererRule(id, 'https://unused.invalid', null); } catch { /* no rule existed */ }
    if (preset) {
      // Revoke the origin unless another enabled preset still uses it. Mirror
      // the domain-wide grant so nothing is left dangling.
      try {
        const stillEnabled = new Set(await sourceCatalogManager.getEnabledIds());
        const origin = new URL(preset.baseUrl).origin;
        const shared = CATALOG.some((p) => stillEnabled.has(p.id) && new URL(p.baseUrl).origin === origin);
        if (!shared) {
          const origins = [...new Set([
            ...originPatternsFor(preset.baseUrl),
            ...(preset.overrides?.imageHosts ?? []).flatMap(originPatternsFor),
            ...learnedHosts.flatMap(originPatternsFor),
          ])];
          await chrome.permissions.remove({ origins });
        }
      } catch { /* best effort */ }
    }
  }

  private async disableCatalogSource(id: string, name: string, list: HTMLElement): Promise<void> {
    if (!confirm(`Remove ${name}? Access to its site is revoked; manga linked to it will need a different source.`)) return;
    await this.catalogDisable(id);
    showDashToast(`${name} removed`);
    this.renderList(list);
  }

  // ── Test harness ──────────────────────────────────────────────────────────

  private async showTestModal(sourceId: string): Promise<void> {
    // Fresh uncached instance so the run hits the live site: user sources
    // get a new DeclarativeSource from the spec, built-ins their raw source
    let source: MangaSource;
    let spec: SourceSpecV1 | null = null;
    if (sourceRegistry.isUserSource(sourceId)) {
      spec = await userSourcesManager.get(sourceId);
      if (!spec) return;
      source = new DeclarativeSource(spec);
    } else {
      const raw = sourceRegistry.getRaw(sourceId);
      if (!raw) return;
      source = raw;
    }

    const { overlay } = buildModal(
      `Test ${escapeHtml(source.name)}`,
      `
        <p class="crd-panel-desc">Runs search, details, chapters, pages, and an image fetch against the live site, bypassing caches.</p>
        <div class="crd-modal-row">
          <input type="text" class="crd-num crd-modal-url" id="crd-test-q" placeholder="Search query" value="the">
          <button class="crd-btn" id="crd-test-run">Run again</button>
        </div>
        <div class="crd-test-log" id="crd-test-log"></div>
      `
    );
    const input = overlay.querySelector<HTMLInputElement>('#crd-test-q')!;
    const runBtn = overlay.querySelector<HTMLButtonElement>('#crd-test-run')!;
    const log = overlay.querySelector<HTMLElement>('#crd-test-log')!;
    const run = () => void this.runTest(source, spec, input.value.trim() || 'the', log, runBtn);

    runBtn.addEventListener('click', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run();
    });
    // Opening the modal is the intent to test: start right away
    run();
  }

  private async runTest(source: MangaSource, spec: SourceSpecV1 | null, query: string, log: HTMLElement, runBtn?: HTMLButtonElement): Promise<void> {
    if (runBtn) runBtn.disabled = true;
    // Heal a stale narrow grant while we still have the click's gesture:
    // pre-domain-wide grants lose the CORS bypass on apex⇄www redirects
    // (no-op when the wide patterns are already held; declining is fine)
    try { await ensureOriginPermissions([source.baseUrl]); } catch { /* best effort */ }
    log.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'crd-test-box';
    log.appendChild(box);

    // Plaintext mirror of the log for the Copy report button (issue reports,
    // pasting into an AI while iterating on a spec)
    const report: string[] = [
      `ComicK Revive source test: ${source.name} (id ${source.id})`,
      `Query: "${query}"`,
    ];

    // Timeline: every step is visible from the start and lights up as the
    // run reaches it; steps after a failure stay dim
    const STEPS = ['Search', 'Details', 'Chapters', 'Pages', 'Image'] as const;
    const rows = new Map<string, { el: HTMLElement; status: HTMLElement; summary: HTMLElement; detail: HTMLElement }>();
    for (const step of STEPS) {
      const el = document.createElement('div');
      el.className = 'crd-test-line pending';
      const status = document.createElement('span');
      status.className = 'crd-test-status';
      const stepEl = document.createElement('span');
      stepEl.className = 'crd-test-step';
      stepEl.textContent = step;
      const summary = document.createElement('span');
      summary.className = 'crd-test-summary';
      const detail = document.createElement('div');
      detail.className = 'crd-test-detail';
      detail.hidden = true;
      el.append(status, stepEl, summary, detail);
      box.appendChild(el);
      rows.set(step, { el, status, summary, detail });
    }

    const setStep = (step: string, state: 'running' | 'ok' | 'fail', summary: string, details: string[] = []) => {
      const row = rows.get(step);
      if (!row) return;
      row.el.classList.remove('pending', 'running', 'ok', 'fail');
      row.el.classList.add(state);
      row.status.innerHTML = state === 'running' ? `<span class="crd-test-spin"></span>` : state === 'ok' ? TEST_OK_SVG : TEST_FAIL_SVG;
      row.summary.textContent = summary;
      if (details.length) {
        row.detail.textContent = details.join('   ·   ');
        row.detail.title = details.join('\n');
        row.detail.hidden = false;
      } else {
        row.detail.hidden = true;
      }
      if (state !== 'running') {
        report.push(`${state === 'ok' ? 'PASS' : 'FAIL'} ${step}: ${summary}${details.length ? ` | ${details.join(' | ')}` : ''}`);
      }
    };

    const finish = (ok: boolean, message: string) => {
      report.push(`Result: ${message}`);
      const foot = document.createElement('div');
      foot.className = `crd-test-foot${ok ? ' ok' : ' fail'}`;
      const msg = document.createElement('span');
      msg.textContent = message;
      const copy = document.createElement('button');
      copy.className = 'crd-btn crd-btn-small';
      copy.textContent = 'Copy report';
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(report.join('\n')).then(() => showDashToast('Report copied'));
      });
      foot.append(msg, copy);
      log.appendChild(foot);
      if (runBtn) runBtn.disabled = false;
    };

    let currentStep = 'Search';
    try {
      setStep('Search', 'running', `searching "${query}"`);
      const results = await source.search(query);
      setStep('Search', results.length > 0 ? 'ok' : 'fail',
        `${results.length} ${results.length === 1 ? 'result' : 'results'}`,
        results[0] ? [`first: ${results[0].title}`, `slug: ${results[0].slug}`] : []);
      if (!results.length) {
        finish(false, 'Search returned nothing. Try another query.');
        return;
      }

      currentStep = 'Details';
      const target = results[0];
      setStep('Details', 'running', `loading "${target.title}"`);
      const details = await source.getMangaDetails(target.slug);
      setStep('Details', details.title ? 'ok' : 'fail', details.title ? `"${details.title}"` : 'no title found', [
        `cover: ${details.thumbnailUrl ? 'yes' : 'MISSING'}`,
        `status: ${details.status || 'unknown'}`,
      ]);

      currentStep = 'Chapters';
      setStep('Chapters', 'running', 'fetching chapter list');
      const chapters = await source.getChapterList(target.slug);
      const first = chapters[chapters.length - 1] ?? chapters[0];
      setStep('Chapters', chapters.length > 0 ? 'ok' : 'fail',
        `${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'}`,
        first ? [
          `first: #${first.number} ${first.title}`,
          `slug: ${first.slug}`,
          first.dateUpload
            ? `date: ${new Date(first.dateUpload).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
            : 'date unparsed',
        ] : []);
      if (!chapters.length) {
        finish(false, 'No chapters found.');
        return;
      }

      currentStep = 'Pages';
      setStep('Pages', 'running', `loading chapter ${first.number}`);
      const pages = await source.getChapterPages(target.slug, first.slug);
      setStep('Pages', pages.length > 0 ? 'ok' : 'fail',
        `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`,
        pages[0] ? [`first: ${pages[0].url}`] : []);
      if (!pages.length) {
        finish(false, 'No pages found.');
        return;
      }

      // Fetch the image for real instead of pre-checking host permission:
      // the background fetch is credential-free, so foreign CDNs with a
      // wildcard ACAO (blogger, imgur, ...) load fine without any grant.
      // Only an actual failure means something is wrong.
      currentStep = 'Image';
      setStep('Image', 'running', 'fetching first page image');
      const imageOrigin = new URL(pages[0].url).origin;

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
        const serverSide = /^HTTP 5\d\d$/.test(imageResult.error ?? '');
        setStep('Image', 'fail', `${imageResult.error || 'first page image failed'} (host: ${imageOrigin})`, [
          serverSide
            ? 'HTTP 5xx = the CDN is failing on its own end (526 means its SSL is broken); nothing to grant, only the site can fix this'
            : spec
              ? (spec.referer && (spec.imageHosts ?? []).some((host) => host.includes('*') && host.includes('://*'))
                  ? 'if this CDN needs a Referer, replace the all-host imageHosts wildcard with the concrete CDN host'
                  : 'check imageHosts and referer')
              : 'this CDN likely needs a Referer; the catalog "partial" chip can grant it, or copy this report into a GitHub issue',
        ]);
        finish(false, 'Failed at image fetch.');
        return;
      }
      setStep('Image', 'ok', 'first page image fetched');

      finish(true, 'All steps passed');
    } catch (error) {
      const blocked = error instanceof SourceError && error.code === 'BLOCKED';
      setStep(currentStep, 'fail', (error as Error).message,
        blocked ? ['This site runs a bot check the extension cannot pass automatically yet.'] : []);
      finish(false, blocked ? 'Blocked by a bot check.' : `Failed at ${currentStep.toLowerCase()}.`);
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
