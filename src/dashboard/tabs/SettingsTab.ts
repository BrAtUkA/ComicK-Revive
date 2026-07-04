import { settingsManager } from '@/core';
import type { GlobalSettings } from '@/types';
import { bridgeCacheUpdateSettings, bridgeCacheStats } from '@/utils/bridge';
import { cacheManager } from '@/viewer/components/CacheManager';
import type { DashboardTab } from '../Dashboard';
import { showDashToast } from '../Dashboard';
import { buildSettingsSchema, CACHE_SETTING_KEYS, type SettingField } from '@/shared/settings-schema';
import { escapeHtml } from '@/shared/fmt';
import { exportBackup, openImportModal, lastBackupAt } from '../dataBackup';
import { manualCheck } from '../updateChecker';

/**
 * Settings — schema-driven editor for GlobalSettings.
 * Every change applies instantly (the viewer reads settings on open).
 * Cache-related keys are additionally pushed to the background cache manager.
 */
export class SettingsTab implements DashboardTab {
  id = 'settings';
  label = 'Settings';
  bottom = true;
  icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2" fill="var(--crd-panel)"/><circle cx="15" cy="12" r="2" fill="var(--crd-panel)"/><circle cx="7" cy="17" r="2" fill="var(--crd-panel)"/></svg>`;

  private settings: GlobalSettings | null = null;

  async mount(host: HTMLElement): Promise<void> {
    this.settings = await settingsManager.load();

    host.innerHTML = `
      <div class="crd-content">
        <h1 class="crd-tab-head">Settings</h1>
        <p class="crd-tab-sub">Changes save instantly and apply the next time the reader opens.</p>
        <div id="crd-set-body"></div>
        <div class="crd-section-label">Data</div>
        <div class="crd-set-group">
          <div class="crd-set-row">
            <div class="crd-set-info">
              <div class="crd-set-name">Backup your data</div>
              <div class="crd-set-desc" id="crd-backup-desc">Reading history, library, stats, sources, and settings. Not cached images.</div>
            </div>
            <button class="crd-btn" id="crd-data-export">Export</button>
          </div>
          <div class="crd-set-row">
            <div class="crd-set-info">
              <div class="crd-set-name">Restore from a backup</div>
              <div class="crd-set-desc">Import a backup file, then choose to merge or replace</div>
            </div>
            <button class="crd-btn" id="crd-data-import">Import</button>
          </div>
        </div>
        <div class="crd-section-label">Storage</div>
        <div class="crd-set-group">
          <div class="crd-set-row">
            <div class="crd-set-info">
              <div class="crd-set-name">Cache manager</div>
              <div class="crd-set-desc" id="crd-cache-usage">Inspect and clear cached chapters per manga</div>
            </div>
            <button class="crd-btn" id="crd-open-cache-manager">Open</button>
          </div>
        </div>
        <div class="crd-section-label">About</div>
        <div class="crd-set-group">
          <div class="crd-set-row">
            <div class="crd-set-info">
              <div class="crd-set-name">Version</div>
              <div class="crd-set-desc" id="crd-about-version">ComicK Revive</div>
            </div>
            <button class="crd-btn" id="crd-check-updates">Check for updates</button>
          </div>
        </div>
        <div class="crd-btn-row">
          <button class="crd-btn danger" id="crd-set-reset">Reset settings to defaults</button>
        </div>
      </div>
    `;

    const body = host.querySelector<HTMLElement>('#crd-set-body')!;
    const schema = buildSettingsSchema();

    for (const section of schema) {
      const label = document.createElement('div');
      label.className = 'crd-section-label';
      label.textContent = section.title;
      body.appendChild(label);

      const group = document.createElement('div');
      group.className = 'crd-set-group';
      for (const field of section.fields) {
        group.appendChild(this.renderField(field));
      }
      body.appendChild(group);
    }

    // Reuse the reader's cache manager modal (works here through the direct
    // bridge transport); show live usage in the row description
    host.querySelector('#crd-open-cache-manager')?.addEventListener('click', () => {
      void cacheManager.show();
    });
    void this.fillCacheUsage(host);

    host.querySelector('#crd-data-export')?.addEventListener('click', () => void exportBackup());
    host.querySelector('#crd-data-import')?.addEventListener('click', () => openImportModal());
    this.showLastBackup(host);

    const manifest = chrome.runtime.getManifest();
    const versionEl = host.querySelector<HTMLElement>('#crd-about-version');
    if (versionEl) versionEl.textContent = `ComicK Revive v${(manifest as { version_name?: string }).version_name ?? manifest.version}`;
    host.querySelector('#crd-check-updates')?.addEventListener('click', () => void manualCheck());
    host.querySelector('#crd-set-reset')?.addEventListener('click', async () => {
      if (!confirm('Reset all settings to defaults?')) return;
      await settingsManager.reset();
      await this.pushCacheSettings();
      showDashToast('Settings reset to defaults');
      this.mount(host);
    });
  }

  private renderField(field: SettingField): HTMLElement {
    const value = this.settings![field.key];
    const row = document.createElement('div');
    row.className = 'crd-set-row';
    row.innerHTML = `
      <div class="crd-set-info">
        <div class="crd-set-name">${escapeHtml(field.label)}</div>
        <div class="crd-set-desc">${escapeHtml(field.desc)}</div>
      </div>
    `;

    switch (field.kind) {
      case 'toggle': {
        const wrap = document.createElement('label');
        wrap.className = 'crd-toggle';
        wrap.innerHTML = `<input type="checkbox" ${value ? 'checked' : ''}><i></i>`;
        wrap.querySelector('input')!.addEventListener('change', (e) => {
          void this.apply(field, (e.target as HTMLInputElement).checked);
        });
        row.appendChild(wrap);
        break;
      }
      case 'select': {
        const select = document.createElement('select');
        select.className = 'crd-select';
        select.innerHTML = field.options
          .map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)
          .join('');
        select.addEventListener('change', () => void this.apply(field, select.value));
        row.appendChild(select);
        break;
      }
      case 'number': {
        const wrap = document.createElement('div');
        wrap.className = 'crd-range-wrap';
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'crd-num';
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step ?? 1);
        input.value = String(value);
        input.addEventListener('change', () => {
          const n = Math.min(field.max, Math.max(field.min, Number(input.value) || field.min));
          input.value = String(n);
          void this.apply(field, n);
        });
        wrap.appendChild(input);
        if (field.unit) {
          const unit = document.createElement('span');
          unit.className = 'crd-range-val';
          unit.textContent = field.unit;
          wrap.appendChild(unit);
        }
        row.appendChild(wrap);
        break;
      }
      case 'range': {
        const wrap = document.createElement('div');
        wrap.className = 'crd-range-wrap';
        wrap.innerHTML = `
          <input type="range" class="crd-range" min="${field.min}" max="${field.max}" step="${field.step ?? 1}" value="${value}">
          <span class="crd-range-val">${value}</span>
        `;
        const input = wrap.querySelector<HTMLInputElement>('input')!;
        const display = wrap.querySelector<HTMLElement>('.crd-range-val')!;
        input.addEventListener('input', () => { display.textContent = input.value; });
        input.addEventListener('change', () => void this.apply(field, Number(input.value)));
        row.appendChild(wrap);
        break;
      }
    }

    return row;
  }

  private async apply(field: SettingField, value: unknown): Promise<void> {
    this.settings = await settingsManager.update({ [field.key]: value } as Partial<GlobalSettings>);
    if (CACHE_SETTING_KEYS.includes(field.key)) {
      await this.pushCacheSettings();
    }
    showDashToast('Saved');
  }

  /** Sync cache-related settings to the background cache manager */
  private async pushCacheSettings(): Promise<void> {
    const s = this.settings ?? await settingsManager.load();
    try {
      const result = await bridgeCacheUpdateSettings({
        enabled: s.enableImageCache,
        ttlDays: s.imageCacheTTLDays,
        maxSizeMB: s.imageCacheMaxSizeMB,
        evictionUnit: s.imageCacheEvictionUnit,
        evictionPriority: s.imageCacheEvictionPriority,
      });
      if (result.evicted && result.evicted.count > 0) {
        showDashToast(`Cache trimmed: ${result.evicted.count} images (${result.evicted.freedMB.toFixed(1)} MB) evicted`);
      }
    } catch (error) {
      console.warn('[Dashboard] Failed to push cache settings:', error);
    }
  }

  private showLastBackup(host: HTMLElement): void {
    const at = lastBackupAt();
    if (!at) return;
    const desc = host.querySelector<HTMLElement>('#crd-backup-desc');
    if (!desc) return;
    const days = Math.floor((Date.now() - at) / 86_400_000);
    const ago = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    desc.innerHTML = `Reading history, library, stats, sources, and settings. Not cached images. <span class="crd-backup-when">Last backup ${ago}.</span>`;
  }

  private async fillCacheUsage(host: HTMLElement): Promise<void> {
    try {
      const stats = await bridgeCacheStats();
      const usage = host.querySelector<HTMLElement>('#crd-cache-usage');
      if (usage) {
        usage.textContent = `${stats.entryCount} images, ${stats.totalSizeMB.toFixed(1)} MB of ${stats.maxSizeMB} MB used`;
      }
    } catch { /* keep the static description */ }
  }
}
