import { statsManager, readingStateManager, dayKey } from '@/core';
import type { DailyStats } from '@/core';
import type { DashboardTab } from '../Dashboard';
import { showDashToast } from '../Dashboard';
import { fmtDuration, fmtDayKey } from '@/shared/fmt';

const RANGE_DAYS = 30;

/**
 * Stats — lifetime tiles + chapters-per-day bar chart.
 * Single-series chart: one validated indigo hue, no legend, per-bar tooltip,
 * peak bar direct-labeled, summary line as the accessible fallback.
 */
export class StatsTab implements DashboardTab {
  id = 'stats';
  label = 'Stats';
  icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6" rx="1"/><rect x="12" y="8" width="3" height="10" rx="1"/><rect x="17" y="5" width="3" height="13" rx="1"/></svg>`;

  async mount(host: HTMLElement): Promise<void> {
    host.innerHTML = `
      <div class="crd-content">
        <h1 class="crd-tab-head">Stats</h1>
        <p class="crd-tab-sub">Your reading activity. Tracking runs while the reader is open and you're actually reading.</p>
        <div id="crd-stats-body"></div>
      </div>
    `;
    const body = host.querySelector<HTMLElement>('#crd-stats-body')!;

    const [totals, streak, range, library] = await Promise.all([
      statsManager.getTotals(),
      statsManager.getCurrentStreak(),
      statsManager.getDailyRange(RANGE_DAYS),
      readingStateManager.getAllWithProgress(),
    ]);

    const readToday = range[range.length - 1]?.stats;
    const tiles = [
      { label: 'Chapters read', value: `${totals.chaptersRead}`, hint: `${totals.chaptersOpened} opened in total` },
      { label: 'Time reading', value: fmtDuration(totals.activeSec), hint: 'active time, idle excluded' },
      { label: 'Current streak', value: `${streak}<small>${streak === 1 ? 'day' : 'days'}</small>`, hint: readToday && (readToday.read > 0 || readToday.opened > 0) ? 'read today ✓' : 'nothing read today yet' },
      { label: 'In library', value: `${library.length}`, hint: 'manga with progress' },
    ];

    body.innerHTML = `
      <div class="crd-tiles">
        ${tiles.map((t) => `
          <div class="crd-tile">
            <div class="crd-tile-label">${t.label}</div>
            <div class="crd-tile-value">${t.value}</div>
            <div class="crd-tile-hint">${t.hint}</div>
          </div>
        `).join('')}
      </div>
      <div class="crd-panel-box">
        <h3 class="crd-panel-title">Chapters per day</h3>
        <p class="crd-panel-desc">Last ${RANGE_DAYS} days</p>
        <div id="crd-chart-host"></div>
      </div>
      <div class="crd-btn-row">
        <button class="crd-btn danger" id="crd-stats-reset">Reset stats</button>
      </div>
    `;

    this.renderChart(body.querySelector<HTMLElement>('#crd-chart-host')!, range);

    body.querySelector('#crd-stats-reset')?.addEventListener('click', async () => {
      if (!confirm('Wipe all reading statistics? Your library and reading positions are not affected.')) return;
      await statsManager.clearAll();
      showDashToast('Stats reset');
      this.mount(host);
    });
  }

  private renderChart(hostEl: HTMLElement, range: Array<{ date: string; stats: DailyStats }>): void {
    const max = Math.max(...range.map((d) => d.stats.read));
    const totalRead = range.reduce((sum, d) => sum + d.stats.read, 0);
    const totalSec = range.reduce((sum, d) => sum + d.stats.activeSec, 0);
    const today = dayKey();

    if (totalRead === 0 && totalSec === 0) {
      hostEl.innerHTML = `
        <div class="crd-empty">
          <h3>No activity recorded yet</h3>
          <p>Stats start counting from today. Open a chapter and this chart comes alive.</p>
        </div>
      `;
      return;
    }

    const peakIndex = max > 0 ? range.findIndex((d) => d.stats.read === max) : -1;
    // Peak value shows in the tooltip and the summary line; a direct label
    // collides with the y-axis max label when the peak is near the edge

    const chart = document.createElement('div');
    chart.className = 'crd-chart';
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', `Chapters read per day over the last ${RANGE_DAYS} days. Total ${totalRead}.`);

    // Recessive grid: baseline + max + midpoint
    const gridlines = max > 0
      ? [{ frac: 0, label: `${max}` }, { frac: 0.5, label: max > 1 ? `${Math.round(max / 2)}` : '' }, { frac: 1, label: '' }]
      : [{ frac: 1, label: '' }];
    const grid = document.createElement('div');
    grid.className = 'crd-chart-grid';
    grid.innerHTML = gridlines.map((g) => `
      <div class="crd-chart-gridline" style="top:${g.frac * 100}%">${g.label ? `<em>${g.label}</em>` : ''}</div>
    `).join('');
    chart.appendChild(grid);

    const bars = document.createElement('div');
    bars.className = 'crd-chart-bars';
    range.forEach((day, i) => {
      const col = document.createElement('div');
      col.className = 'crd-bar-col';
      const heightPct = max > 0 ? (day.stats.read / max) * 100 : 0;
      col.innerHTML = `
        <div class="crd-bar${day.stats.read === 0 ? ' zero' : ''}" style="height:${Math.max(heightPct, 1.5)}%"></div>
      `;
      col.addEventListener('mouseenter', () => {
        chart.querySelector('.crd-chart-tip')?.remove();
        const tip = document.createElement('div');
        tip.className = 'crd-chart-tip';
        tip.innerHTML = `<b>${day.stats.read}</b> ${day.stats.read === 1 ? 'chapter' : 'chapters'}${day.stats.activeSec >= 60 ? ` · ${fmtDuration(day.stats.activeSec)}` : ''}<em>${fmtDayKey(day.date)}${day.date === today ? ' · today' : ''}</em>`;
        col.appendChild(tip);
        // keep the tooltip inside the chart on edge bars
        const tipRect = tip.getBoundingClientRect();
        const chartRect = chart.getBoundingClientRect();
        if (tipRect.left < chartRect.left) tip.style.transform = 'translateX(-20%)';
        else if (tipRect.right > chartRect.right) tip.style.transform = 'translateX(-80%)';
      });
      col.addEventListener('mouseleave', () => chart.querySelector('.crd-chart-tip')?.remove());
      bars.appendChild(col);
    });
    chart.appendChild(bars);

    // Sparse x-axis labels (weekly)
    const xAxis = document.createElement('div');
    xAxis.className = 'crd-chart-x';
    xAxis.innerHTML = range.map((day, i) => `<span>${i % 7 === 1 ? fmtDayKey(day.date) : ''}</span>`).join('');
    chart.appendChild(xAxis);

    hostEl.appendChild(chart);

    const summary = document.createElement('div');
    summary.className = 'crd-chart-summary';
    const busiest = peakIndex >= 0 ? ` · busiest day ${fmtDayKey(range[peakIndex].date)} (${max})` : '';
    summary.textContent = `${totalRead} chapters and ${fmtDuration(totalSec)} of reading in the last ${RANGE_DAYS} days${busiest}`;
    hostEl.appendChild(summary);
  }
}
