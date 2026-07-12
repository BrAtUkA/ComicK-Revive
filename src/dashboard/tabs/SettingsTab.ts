import { settingsManager } from '@/core';
import type { GlobalSettings } from '@/types';
import { bridgeCacheUpdateSettings, bridgeCacheStats } from '@/utils/bridge';
import { cacheManager } from '@/viewer/components/CacheManager';
import type { DashboardTab } from '../Dashboard';
import { showDashToast } from '../Dashboard';
import { buildSettingsSchema, CACHE_SETTING_KEYS, type SettingField } from '@/shared/settings-schema';
import { escapeHtml } from '@/shared/fmt';
import { buildDropdown } from '../dropdown';
import { confirmModal } from './libraryCommon';
import { exportBackup, openImportModal, lastBackupAt } from '../dataBackup';
import { manualCheck } from '../updateChecker';

const REPO_URL = 'https://github.com/BrAtUkA/ComicK-Revive';

type NumberField = Extract<SettingField, { kind: 'number' }>;

/**
 * Settings — schema-driven editor for GlobalSettings.
 * Every change applies instantly (the viewer reads settings on open) and
 * acknowledges with a soft pulse on its own row, not a toast per click.
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
    const manifest = chrome.runtime.getManifest();
    const version = (manifest as { version_name?: string }).version_name ?? manifest.version;

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
              <div class="crd-set-desc">Reading history, library, stats, sources, and settings. Not cached images.</div>
              <div class="crd-set-meta quiet" id="crd-backup-meta"></div>
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
              <div class="crd-set-desc">ComicK Revive v${escapeHtml(version)}</div>
            </div>
            <button class="crd-btn" id="crd-check-updates">Check for updates</button>
          </div>
          <div class="crd-set-row">
            <div class="crd-set-info">
              <div class="crd-set-name">Project page</div>
              <div class="crd-set-desc">Source code, releases, and the README</div>
            </div>
            <a class="crd-btn" href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
          </div>
          <div class="crd-set-row">
            <div class="crd-set-info">
              <div class="crd-set-name">Found a bug?</div>
              <div class="crd-set-desc">Open an issue. For broken sources, attach the test modal's copied report.</div>
            </div>
            <a class="crd-btn" href="${REPO_URL}/issues" target="_blank" rel="noopener">Report</a>
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

    host.querySelector('#crd-data-export')?.addEventListener('click', () => void (async () => {
      await exportBackup();
      this.showLastBackup(host);
    })());
    host.querySelector('#crd-data-import')?.addEventListener('click', () => openImportModal());
    this.showLastBackup(host);

    host.querySelector('#crd-check-updates')?.addEventListener('click', () => void manualCheck());
    host.querySelector('#crd-set-reset')?.addEventListener('click', () => {
      confirmModal({
        title: 'Reset settings',
        body: 'Returns every setting to its default. Your library, history, stats, and sources are not touched.',
        confirmLabel: 'Reset settings',
        danger: true,
        onConfirm: () => void (async () => {
          await settingsManager.reset();
          this.settings = await settingsManager.load();
          await this.pushCacheSettings();
          showDashToast('Settings reset to defaults');
          void this.mount(host);
        })(),
      });
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
          void this.apply(field, (e.target as HTMLInputElement).checked, row);
        });
        row.appendChild(wrap);
        break;
      }
      case 'select': {
        const dd = buildDropdown({
          options: field.options.map((o) => ({ value: o.value, label: o.label })),
          value: String(value),
          onChange: (v) => void this.apply(field, v, row),
        });
        row.appendChild(dd.el);
        break;
      }
      case 'number': {
        row.appendChild(this.buildStepper(field, Number(value), (n) => void this.apply(field, n, row)));
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
        input.addEventListener('change', () => void this.apply(field, Number(input.value), row));
        row.appendChild(wrap);
        break;
      }
    }

    return row;
  }

  /**
   * Custom number control: [−] value unit [+]. Replaces input[type=number],
   * whose native spin buttons don't match the theme. Typing is free-form and
   * commits on Enter or blur; junk reverts, out-of-range clamps, and the
   * −/+ buttons snap back onto the step grid.
   */
  private buildStepper(field: NumberField, initial: number, commit: (n: number) => void): HTMLElement {
    const step = field.step ?? 1;
    const wrap = document.createElement('div');
    wrap.className = 'crd-stepper';

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'crd-step-btn';
    minus.textContent = '−';
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'crd-step-btn';
    plus.textContent = '+';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'crd-step-input';

    let current = Number.isFinite(initial) ? initial : field.min;
    const clamp = (n: number) => Math.min(field.max, Math.max(field.min, n));
    const render = () => {
      input.value = String(current);
      minus.disabled = current <= field.min;
      plus.disabled = current >= field.max;
    };
    const setValue = (n: number) => {
      const next = Math.round(clamp(n) * 1000) / 1000;
      if (next === current) {
        render();
        return;
      }
      current = next;
      render();
      commit(current);
    };
    // Off-grid values (typed by hand) snap to the nearest step in the
    // pressed direction instead of drifting off by a remainder forever
    const nudge = (dir: 1 | -1) => {
      const k = (current - field.min) / step;
      const snapped = Number.isInteger(k) ? current + dir * step : field.min + (dir > 0 ? Math.ceil(k) : Math.floor(k)) * step;
      setValue(snapped);
    };

    minus.addEventListener('click', () => nudge(-1));
    plus.addEventListener('click', () => nudge(1));
    const commitTyped = () => {
      const n = Number(input.value.trim().replace(',', '.'));
      if (!Number.isFinite(n)) {
        render(); // junk input: revert to the last good value
        return;
      }
      setValue(n);
    };
    input.addEventListener('change', commitTyped);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commitTyped();
        input.blur();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        nudge(1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        nudge(-1);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        render();
        input.blur();
      }
    });

    wrap.append(minus, input);
    if (field.unit) {
      const unit = document.createElement('span');
      unit.className = 'crd-step-unit';
      unit.textContent = field.unit;
      wrap.appendChild(unit);
    }
    wrap.appendChild(plus);
    render();
    return wrap;
  }

  private async apply(field: SettingField, value: unknown, row?: HTMLElement): Promise<void> {
    this.settings = await settingsManager.update({ [field.key]: value } as Partial<GlobalSettings>);
    if (CACHE_SETTING_KEYS.includes(field.key)) {
      await this.pushCacheSettings();
    }
    // Acknowledge on the row itself; a toast per toggle click is noise
    if (row) {
      row.classList.remove('flash');
      void row.offsetWidth;
      row.classList.add('flash');
    }
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
    const meta = host.querySelector<HTMLElement>('#crd-backup-meta');
    if (!meta) return;
    const at = lastBackupAt();
    if (!at) {
      meta.textContent = 'No backup yet';
      meta.classList.add('quiet');
      return;
    }
    const d = new Date(at);
    // Calendar days, not rolling 24h windows: a 9pm backup viewed the next
    // morning should read "yesterday", not "today"
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
    const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    meta.textContent = `Last backup ${when} at ${time}`;
    meta.title = d.toLocaleString();
    meta.classList.remove('quiet');
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
