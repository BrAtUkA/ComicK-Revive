/**
 * ComicK Revive — Popup (extension page context)
 *
 * Quick-glance surface on the toolbar icon: continue-reading list, a mini
 * stats strip, and the door to the full dashboard. Uses the same direct
 * bridge transport and shared helpers as the dashboard.
 */

import './popup.css';
import { readingStateManager, sourceMappingManager, statsManager } from '@/core';
import { getCoverDataUrl } from '@/shared/covers';
import { timeAgo, titleFromSlug, escapeHtml, fmtDuration } from '@/shared/fmt';

const MAX_ROWS = 10;

const BRAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>`;
const DASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`;
const CHEVRON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;

/** Open (or focus) the dashboard tab, then close the popup */
function openDashboard(hash = ''): void {
  const dashboardUrl = chrome.runtime.getURL('dashboard.html');
  chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
    const existing = tabs[0];
    if (existing?.id !== undefined) {
      chrome.tabs.update(existing.id, { active: true, url: hash ? dashboardUrl + hash : undefined });
      if (existing.windowId !== undefined) {
        chrome.windows.update(existing.windowId, { focused: true });
      }
    } else {
      chrome.tabs.create({ url: dashboardUrl + hash });
    }
    window.close();
  });
}

function openResume(comickSlug: string): void {
  // Everything resumes in the dashboard reader (decided 2026-07-06);
  // comick.dev stays a click away from the library details view
  openDashboard(`#read=${encodeURIComponent(comickSlug)}`);
}

async function render(): Promise<void> {
  const root = document.getElementById('crp-app');
  if (!root) return;

  root.innerHTML = `
    <header class="crp-head">
      <div class="crd-brand-mark">${BRAND_SVG}</div>
      <div class="crp-title-text">ComicK Revive</div>
      <button class="crp-icon-btn" id="crp-dash-btn" title="Open dashboard">${DASH_SVG}</button>
    </header>
    <div class="crp-stats" id="crp-stats" hidden></div>
    <div class="crp-section">
      <span class="crp-section-label">Continue reading</span>
      <button class="crp-view-all" id="crp-view-all">View all</button>
    </div>
    <div class="crp-list" id="crp-list"></div>
    <footer class="crp-foot">
      <button class="crd-btn" id="crp-dash-open">Open dashboard</button>
    </footer>
  `;

  root.querySelector('#crp-dash-btn')?.addEventListener('click', () => openDashboard());
  root.querySelector('#crp-dash-open')?.addEventListener('click', () => openDashboard());
  root.querySelector('#crp-view-all')?.addEventListener('click', () => openDashboard('#library'));

  await Promise.all([renderList(root), renderStats(root)]);
}

async function renderList(root: HTMLElement): Promise<void> {
  const list = root.querySelector<HTMLElement>('#crp-list')!;

  const [withProgress, mappings] = await Promise.all([
    readingStateManager.getAllWithProgress(),
    sourceMappingManager.getAll(),
  ]);
  const mappingBySlug = new Map(mappings.map((m) => [m.comickSlug, m]));

  const recent = withProgress
    .sort((a, b) => (b.state.lastRead || 0) - (a.state.lastRead || 0))
    .slice(0, MAX_ROWS);

  if (recent.length === 0) {
    list.innerHTML = `
      <div class="crp-empty">
        <b>Nothing in progress</b>
        Start reading on comick.dev and your manga show up here.
      </div>
    `;
    return;
  }

  for (const { slug, state } of recent) {
    const mapping = mappingBySlug.get(slug) ?? null;
    const title = mapping?.customTitle || mapping?.comickTitle || titleFromSlug(slug);

    const row = document.createElement('button');
    row.className = 'crp-row';
    row.title = `Continue reading from chapter ${state.currentChapter}`;
    row.innerHTML = `
      <div class="crp-thumb">${escapeHtml(title.slice(0, 1).toUpperCase())}</div>
      <div class="crp-row-body">
        <div class="crp-row-title">${escapeHtml(title)}</div>
        <div class="crp-row-meta"><em>Ch. ${state.currentChapter}</em>${state.lastRead ? ` · ${timeAgo(state.lastRead)}` : ''}</div>
      </div>
      <span class="crp-row-chevron">${CHEVRON_SVG}</span>
    `;
    row.addEventListener('click', () => openResume(slug));
    list.appendChild(row);

    void hydrateThumb(row, mapping);
  }
}

async function hydrateThumb(row: HTMLElement, mapping: { selectedSource: string; sources: Record<string, { slug: string }> } | null): Promise<void> {
  const sourceId = mapping?.selectedSource;
  const sourceSlug = sourceId ? mapping?.sources[sourceId]?.slug : undefined;
  if (!sourceId || !sourceSlug) return;

  const dataUrl = await getCoverDataUrl(sourceId, sourceSlug);
  if (!dataUrl) return;

  const thumb = row.querySelector<HTMLElement>('.crp-thumb');
  if (thumb) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = dataUrl;
    img.addEventListener('load', () => {
      thumb.textContent = '';
      thumb.appendChild(img);
    }, { once: true });
  }
}

async function renderStats(root: HTMLElement): Promise<void> {
  try {
    const [week, streak] = await Promise.all([
      statsManager.getDailyRange(7),
      statsManager.getCurrentStreak(),
    ]);
    const today = week[week.length - 1]?.stats;
    const weekSec = week.reduce((sum, d) => sum + d.stats.activeSec, 0);

    const host = root.querySelector<HTMLElement>('#crp-stats');
    if (!host) return;
    host.hidden = false;
    host.innerHTML = `
      <div class="crp-stat"><b>${today?.read ?? 0}</b><span>today</span></div>
      <div class="crp-stat"><b>${fmtDuration(weekSec)}</b><span>this week</span></div>
      <div class="crp-stat"><b>${streak}</b><span>streak</span></div>
    `;
  } catch { /* stats strip stays hidden */ }
}

void render();
