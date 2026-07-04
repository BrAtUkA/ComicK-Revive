/**
 * Data backup UX (dashboard): export a full backup file, and import one with
 * a preview + merge/replace choice. Wraps the pure logic in
 * @/shared/backup and layers on the dashboard-only concerns: permission
 * prompts and referer rules for imported user sources, and a safety backup
 * taken automatically before any import is applied.
 */

import {
  buildBackup, collectBackupData, mergeData, validateBackup, summarize,
  extractUserSpecs, applySnapshot, type BackupEnvelope, type BackupSummary,
} from '@/shared/backup';
import type { SourceSpecV1 } from '@/sources/spec/SourceSpec';
import { buildModal } from './modal';
import { showDashToast } from './Dashboard';
import { setRefererRule } from './sourcePermissions';
import { escapeHtml } from '@/shared/fmt';

const LAST_BACKUP_KEY = 'crd_last_backup_at';

function extVersion(): string {
  const m = chrome.runtime.getManifest();
  return (m as { version_name?: string }).version_name ?? m.version;
}

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function lastBackupAt(): number | null {
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  return raw ? Number(raw) : null;
}

export async function exportBackup(): Promise<void> {
  const env = await buildBackup(extVersion());
  downloadJson(env, `comick-revive-backup-${stamp()}.json`);
  localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));
  showDashToast('Backup downloaded');
}

/** Origins a set of user specs need access to (base, icon, referer, image hosts). */
function specOrigins(specs: SourceSpecV1[]): string[] {
  const out = new Set<string>();
  for (const spec of specs) {
    for (const raw of [spec.baseUrl, spec.iconUrl, spec.referer, ...(spec.imageHosts ?? [])]) {
      if (!raw) continue;
      try {
        out.add(raw.includes('*') ? raw : new URL(raw).origin + '/*');
      } catch { /* skip malformed */ }
    }
  }
  return [...out];
}

export function openImportModal(): void {
  const { overlay, close } = buildModal('Import data', `
    <p class="crd-panel-desc">Restore reading history, library, stats, sources, and settings from a backup file. Cached images are not included (they re-download as you read).</p>
    <div class="crd-import-drop" id="crd-import-drop">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      <span>Drop a backup file here, or <b>choose a file</b></span>
    </div>
    <div id="crd-import-stage"></div>
  `, { large: true });

  const drop = overlay.querySelector<HTMLElement>('#crd-import-drop')!;
  const stage = overlay.querySelector<HTMLElement>('#crd-import-stage')!;

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void loadFile(file, stage, close);
    });
    input.click();
  };

  drop.addEventListener('click', pickFile);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadFile(file, stage, close);
  });
}

async function loadFile(file: File, stage: HTMLElement, close: () => void): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    stage.innerHTML = `<div class="crd-import-errors">This file is not valid JSON.</div>`;
    return;
  }

  const { errors, envelope } = validateBackup(parsed);
  if (!envelope) {
    stage.innerHTML = `<div class="crd-import-errors">${errors.map((e) => `<div>• ${escapeHtml(e)}</div>`).join('')}</div>`;
    return;
  }

  renderPreview(stage, envelope, close);
}

function renderPreview(stage: HTMLElement, env: BackupEnvelope, close: () => void): void {
  const s = summarize(env);
  const when = s.exportedAt ? new Date(s.exportedAt).toLocaleString() : 'unknown date';
  const rangeText = s.statsRange ? `${s.statsRange.from} to ${s.statsRange.to}` : 'none';

  stage.innerHTML = `
    <div class="crd-import-summary">
      <div class="crd-import-stat"><b>${s.mangaWithProgress}</b><span>manga with progress</span></div>
      <div class="crd-import-stat"><b>${s.linkedManga}</b><span>library entries</span></div>
      <div class="crd-import-stat"><b>${s.chaptersRead}</b><span>chapters read</span></div>
      <div class="crd-import-stat"><b>${s.statsDays}</b><span>days of stats</span></div>
      <div class="crd-import-stat"><b>${s.userSources.length}</b><span>custom sources</span></div>
    </div>
    <div class="crd-import-meta">
      Exported ${escapeHtml(when)}${s.extensionVersion ? ` from v${escapeHtml(s.extensionVersion)}` : ''} · stats span ${escapeHtml(rangeText)}${s.userSources.length ? ` · sources: ${escapeHtml(s.userSources.join(', '))}` : ''}
    </div>

    <div class="crd-import-options">
      <label class="crd-import-mode">
        <input type="radio" name="crd-import-mode" value="merge" checked>
        <div><b>Merge</b><span>Keep what you have and add what's missing. Newer progress wins per manga.</span></div>
      </label>
      <label class="crd-import-mode">
        <input type="radio" name="crd-import-mode" value="replace">
        <div><b>Replace</b><span>Wipe current data and restore the backup exactly. For moving to a new install.</span></div>
      </label>
      <label class="crd-set-row crd-import-toggle">
        <div class="crd-set-info"><div class="crd-set-name">Include settings &amp; source order</div><div class="crd-set-desc">Also restore reader preferences and source priority${s.hasSettings ? '' : ' (this backup has none)'}</div></div>
        <span class="crd-toggle"><input type="checkbox" id="crd-import-settings" ${s.hasSettings ? '' : 'disabled'}><i></i></span>
      </label>
    </div>

    <div class="crd-import-note">A safety backup of your current data downloads automatically before anything changes.</div>
    <div class="crd-btn-row">
      <button class="crd-btn crd-btn-primary" id="crd-import-apply">Import</button>
    </div>
  `;

  stage.querySelector<HTMLButtonElement>('#crd-import-apply')!
    .addEventListener('click', (e) => void applyImport(e.currentTarget as HTMLButtonElement, env, s, close));
}

async function applyImport(btn: HTMLButtonElement, env: BackupEnvelope, summary: BackupSummary, close: () => void): Promise<void> {
  const stage = btn.closest('#crd-import-stage') as HTMLElement;
  const mode = (stage.querySelector<HTMLInputElement>('input[name="crd-import-mode"]:checked')?.value ?? 'merge') as 'merge' | 'replace';
  const includeSettings = !!stage.querySelector<HTMLInputElement>('#crd-import-settings')?.checked;

  const specs = extractUserSpecs(env.data);

  // Request source origins FIRST, synchronously in this click handler, so the
  // user gesture that permits chrome.permissions.request is still live.
  // Already-granted origins resolve without a prompt.
  const origins = specOrigins(specs);
  if (origins.length) {
    try { await chrome.permissions.request({ origins }); } catch { /* proceed; images may need a later grant */ }
  }

  btn.disabled = true;
  btn.textContent = 'Importing…';

  try {
    // Safety backup of the CURRENT state before touching anything
    downloadJson(await buildBackup(extVersion()), `comick-revive-before-import-${stamp()}.json`);

    const current = await collectBackupData();
    const { writes, removes } = mergeData(current, env.data, { mode, includeSettings });
    await applySnapshot(writes, removes);

    // Referer rules for imported user sources (rotating CDNs still get topped
    // up at runtime by the background)
    for (const spec of specs) {
      if (spec.referer) {
        try { await setRefererRule(spec.id, spec.baseUrl, spec.referer, spec.imageHosts ?? []); } catch { /* non-fatal */ }
      }
    }

    close();
    showDashToast(`Imported ${summary.mangaWithProgress} manga. Reloading…`);
    setTimeout(() => location.reload(), 900);
  } catch (error) {
    btn.disabled = false;
    btn.textContent = 'Import';
    stage.querySelector('.crd-import-note')?.insertAdjacentHTML('afterend',
      `<div class="crd-import-errors">Import failed: ${escapeHtml((error as Error).message)}</div>`);
  }
}
