import { statsManager, readingStateManager, historyManager, sourceMappingManager, dayKey } from '@/core';
import type { DailyStats, HistoryEntry } from '@/core';
import type { MangaSourceMapping } from '@/types';
import { getCoverDataUrl } from '@/shared/covers';
import type { DashboardTab } from '../Dashboard';
import { showDashToast } from '../Dashboard';
import { fmtDuration, fmtDayKey } from '@/shared/fmt';
import { entryTitle, selectedSourceOf, detailsHash, confirmModal } from './libraryCommon';

const RANGE_DAYS = 30;
const HEAT_DAYS = 365;
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

/**
 * Stats — tiles, a dual-metric daily chart, a year heatmap, weekday and
 * time-of-day patterns, a most-read ranking, and records.
 * Single-series charts throughout: one validated indigo hue, no legends
 * (titles name the series), per-mark tooltips, text in ink tokens.
 */
export class StatsTab implements DashboardTab {
  id = 'stats';
  label = 'Stats';
  icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6" rx="1"/><rect x="12" y="8" width="3" height="10" rx="1"/><rect x="17" y="5" width="3" height="13" rx="1"/></svg>`;

  private coverCache = new Map<string, string | null>();

  async mount(host: HTMLElement): Promise<void> {
    host.innerHTML = `
      <div class="crd-content">
        <h1 class="crd-tab-head">Stats</h1>
        <p class="crd-tab-sub">Your reading activity. Tracking runs while the reader is open and you're actually reading.</p>
        <div id="crd-stats-body"></div>
      </div>
    `;
    const body = host.querySelector<HTMLElement>('#crd-stats-body')!;

    const [totals, streak, range, library, allDaily, history, mappings] = await Promise.all([
      statsManager.getTotals(),
      statsManager.getCurrentStreak(),
      statsManager.getDailyRange(RANGE_DAYS),
      readingStateManager.getAllWithProgress(),
      statsManager.getAllDaily(),
      historyManager.getAll(),
      sourceMappingManager.getAll(),
    ]);
    const mappingBySlug = new Map(mappings.map((m) => [m.comickSlug, m]));

    // Ignore history orphans (manga removed before removal purged history):
    // they have no title to show and no library entry to open
    const knownSlugs = new Set(library.map((l) => l.slug));
    const visibleHistory = history.filter((e) => knownSlugs.has(e.slug) || mappingBySlug.has(e.slug));

    // ── Tiles ────────────────────────────────────────────────────────────────
    const readToday = range[range.length - 1]?.stats;
    const tiles = [
      { label: 'Chapters read', value: `${totals.chaptersRead}`, hint: `${totals.chaptersOpened} opened in total` },
      { label: 'Time reading', value: fmtDuration(totals.activeSec), hint: 'active time, idle excluded' },
      { label: 'Current streak', value: `${streak}<small>${streak === 1 ? 'day' : 'days'}</small>`, hint: readToday && (readToday.read > 0 || readToday.opened > 0) ? 'read today ✓' : 'nothing read today yet' },
      { label: 'In library', value: `${library.length}`, hint: 'manga with progress' },
    ];
    const tilesEl = document.createElement('div');
    tilesEl.className = 'crd-tiles';
    tilesEl.innerHTML = tiles.map((t) => `
      <div class="crd-tile">
        <div class="crd-tile-label">${t.label}</div>
        <div class="crd-tile-value">${t.value}</div>
        <div class="crd-tile-hint">${t.hint}</div>
      </div>
    `).join('');
    body.appendChild(tilesEl);

    const hasAnyActivity = totals.chaptersOpened > 0 || totals.activeSec > 0 || history.length > 0;
    if (!hasAnyActivity) {
      body.insertAdjacentHTML('beforeend', `
        <div class="crd-empty">
          <h3>No activity recorded yet</h3>
          <p>Open a chapter and this page comes alive.</p>
        </div>
      `);
      return;
    }

    // ── Daily activity (chapters / time toggle) ──────────────────────────────
    body.appendChild(this.buildDailyPanel(range));

    // ── Year heatmap ─────────────────────────────────────────────────────────
    body.appendChild(this.buildHeatmapPanel(allDaily));

    // ── Weekday + time-of-day patterns ───────────────────────────────────────
    const patterns = document.createElement('div');
    patterns.className = 'crd-stats-duo';
    patterns.append(
      this.buildWeekdayPanel(allDaily),
      this.buildTimeOfDayPanel(visibleHistory),
    );
    body.appendChild(patterns);

    // ── Most read + records ──────────────────────────────────────────────────
    const bottom = document.createElement('div');
    bottom.className = 'crd-stats-duo';
    bottom.append(
      this.buildMostReadPanel(visibleHistory, mappingBySlug),
      this.buildRecordsPanel(allDaily, totals.chaptersRead, totals.firstTrackedAt),
    );
    body.appendChild(bottom);

    const btnRow = document.createElement('div');
    btnRow.className = 'crd-btn-row';
    const reset = document.createElement('button');
    reset.className = 'crd-btn danger';
    reset.textContent = 'Reset stats';
    reset.addEventListener('click', () => {
      confirmModal({
        title: 'Reset stats',
        body: 'Wipes all reading statistics. Your library, history, and reading positions are not affected.',
        confirmLabel: 'Reset',
        danger: true,
        onConfirm: () => void (async () => {
          await statsManager.clearAll();
          showDashToast('Stats reset');
          void this.mount(host);
        })(),
      });
    });
    btnRow.appendChild(reset);
    body.appendChild(btnRow);
  }

  // ── Panels ─────────────────────────────────────────────────────────────────

  private buildDailyPanel(range: Array<{ date: string; stats: DailyStats }>): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'crd-panel-box';
    panel.innerHTML = `
      <div class="crd-panel-head">
        <div>
          <h3 class="crd-panel-title">Daily activity</h3>
          <p class="crd-panel-desc">Last ${RANGE_DAYS} days</p>
        </div>
        <div class="crd-metric-pills">
          <button class="crd-pill active" data-metric="read">Chapters</button>
          <button class="crd-pill" data-metric="time">Time</button>
        </div>
      </div>
      <div id="crd-daily-chart"></div>
    `;
    const chartHost = panel.querySelector<HTMLElement>('#crd-daily-chart')!;
    const today = dayKey();

    const render = (metric: 'read' | 'time') => {
      chartHost.innerHTML = '';
      const isTime = metric === 'time';
      const values = range.map((d) => (isTime ? Math.round(d.stats.activeSec / 60) : d.stats.read));
      const fmtVal = (v: number) => (isTime ? fmtDuration(v * 60) : String(v));
      const totalRead = range.reduce((s, d) => s + d.stats.read, 0);
      const totalSec = range.reduce((s, d) => s + d.stats.activeSec, 0);

      this.renderBars(chartHost, {
        values,
        ariaLabel: `${isTime ? 'Reading time' : 'Chapters read'} per day over the last ${RANGE_DAYS} days.`,
        gridLabel: fmtVal,
        xLabel: (i) => (i % 7 === 1 ? fmtDayKey(range[i].date) : ''),
        tip: (i) => {
          const d = range[i];
          const big = isTime ? fmtDuration(d.stats.activeSec) : `${d.stats.read} ${d.stats.read === 1 ? 'chapter' : 'chapters'}`;
          const extra = isTime
            ? (d.stats.read > 0 ? ` · ${d.stats.read} ch` : '')
            : (d.stats.activeSec >= 60 ? ` · ${fmtDuration(d.stats.activeSec)}` : '');
          return { big: big + extra, small: fmtDayKey(d.date) + (d.date === today ? ' · today' : '') };
        },
        summary: `${totalRead} chapters and ${fmtDuration(totalSec)} of reading in the last ${RANGE_DAYS} days`,
      });
    };

    panel.querySelectorAll<HTMLButtonElement>('.crd-metric-pills .crd-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        panel.querySelectorAll('.crd-metric-pills .crd-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        render(pill.dataset.metric as 'read' | 'time');
      });
    });

    render('read');
    return panel;
  }

  private buildHeatmapPanel(allDaily: Record<string, DailyStats>): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'crd-panel-box';
    panel.innerHTML = `
      <h3 class="crd-panel-title">Past year</h3>
      <p class="crd-panel-desc">One cell per day, darker means more chapters read</p>
      <div class="crd-heat-scroll">
        <div class="crd-heat-months"></div>
        <div class="crd-heat" role="img"></div>
      </div>
      <div class="crd-heat-foot">
        <span class="crd-heat-total"></span>
        <span class="crd-heat-scale">Less
          <i style="background:var(--crd-line)"></i>
          <i style="background:rgba(99,102,241,0.25)"></i>
          <i style="background:rgba(99,102,241,0.45)"></i>
          <i style="background:var(--crd-accent)"></i>
          <i style="background:var(--crd-accent-2)"></i>
        More</span>
      </div>
    `;

    const grid = panel.querySelector<HTMLElement>('.crd-heat')!;
    const months = panel.querySelector<HTMLElement>('.crd-heat-months')!;

    // Monday-aligned window ending today
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - (HEAT_DAYS - 1));
    while (start.getDay() !== 1) start.setDate(start.getDate() - 1);

    const level = (read: number) => (read >= 7 ? 4 : read >= 4 ? 3 : read >= 2 ? 2 : read >= 1 ? 1 : 0);
    const todayKey = dayKey(today);
    let yearTotal = 0;
    let prevMonth = -1;
    const cursor = new Date(start);
    const frag = document.createDocumentFragment();

    while (true) {
      const weekStartMonth = cursor.getMonth();
      const label = document.createElement('span');
      label.style.width = '13px';
      label.style.flexShrink = '0';
      label.style.whiteSpace = 'nowrap';
      label.style.overflow = 'visible';
      if (weekStartMonth !== prevMonth) {
        label.textContent = cursor.toLocaleDateString(undefined, { month: 'short' });
        prevMonth = weekStartMonth;
      }
      months.appendChild(label);

      for (let d = 0; d < 7; d++) {
        const key = dayKey(cursor);
        const cell = document.createElement('span');
        cell.className = 'crd-heat-cell';
        if (key > todayKey) {
          cell.classList.add('future');
        } else {
          const stats = allDaily[key];
          const read = stats?.read ?? 0;
          yearTotal += read;
          const lv = level(read);
          if (lv > 0) cell.classList.add(`l${lv}`);
          cell.title = `${read} ${read === 1 ? 'chapter' : 'chapters'} · ${new Date(cursor).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
        }
        frag.appendChild(cell);
        cursor.setDate(cursor.getDate() + 1);
      }
      if (dayKey(cursor) > todayKey) break;
    }

    grid.appendChild(frag);
    grid.setAttribute('aria-label', `Chapters read per day over the past year. Total ${yearTotal}.`);
    panel.querySelector('.crd-heat-total')!.textContent = `${yearTotal} chapters in the past year`;
    return panel;
  }

  private buildWeekdayPanel(allDaily: Record<string, DailyStats>): HTMLElement {
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const totals = new Array(7).fill(0) as number[];
    for (const [key, stats] of Object.entries(allDaily)) {
      const [y, m, d] = key.split('-').map(Number);
      const idx = (new Date(y, m - 1, d).getDay() + 6) % 7;
      totals[idx] += stats.read;
    }

    const panel = document.createElement('div');
    panel.className = 'crd-panel-box';
    panel.innerHTML = `
      <h3 class="crd-panel-title">By weekday</h3>
      <p class="crd-panel-desc">Chapters read, all time</p>
      <div class="crd-wd-chart"></div>
    `;
    this.renderBars(panel.querySelector<HTMLElement>('.crd-wd-chart')!, {
      values: totals,
      height: 130,
      ariaLabel: 'Chapters read per weekday.',
      gridLabel: (v) => String(v),
      xLabel: (i) => names[i],
      tip: (i) => ({ big: `${totals[i]} ${totals[i] === 1 ? 'chapter' : 'chapters'}`, small: names[i] }),
    });
    return panel;
  }

  private buildTimeOfDayPanel(history: HistoryEntry[]): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'crd-panel-box';
    panel.innerHTML = `
      <h3 class="crd-panel-title">By time of day</h3>
      <p class="crd-panel-desc">Chapters opened, from your history</p>
      <div class="crd-tod-chart"></div>
    `;
    const chartHost = panel.querySelector<HTMLElement>('.crd-tod-chart')!;

    // Seeded entries carry a synthetic noon timestamp; they would fake a spike
    const real = history.filter((e) => !e.seeded);
    const buckets = new Array(12).fill(0) as number[];
    for (const e of real) {
      buckets[Math.floor(new Date(e.at).getHours() / 2)]++;
    }

    if (real.length === 0) {
      chartHost.remove();
      panel.insertAdjacentHTML('beforeend', `<p class="crd-duo-empty">Builds up as you read. History logging is new, so give it a few sessions.</p>`);
      return panel;
    }

    const bucketLabel = (i: number) => `${String(i * 2).padStart(2, '0')}:00 to ${String(i * 2 + 2).padStart(2, '0')}:00`;
    this.renderBars(chartHost, {
      values: buckets,
      height: 130,
      ariaLabel: 'Chapters opened by time of day.',
      gridLabel: (v) => String(v),
      xLabel: (i) => (i % 2 === 0 ? String(i * 2).padStart(2, '0') : ''),
      tip: (i) => ({ big: `${buckets[i]} ${buckets[i] === 1 ? 'chapter' : 'chapters'}`, small: bucketLabel(i) }),
    });
    return panel;
  }

  private buildMostReadPanel(history: HistoryEntry[], mappingBySlug: Map<string, MangaSourceMapping>): HTMLElement {
    const counts = new Map<string, number>();
    for (const e of history) {
      counts.set(e.slug, (counts.get(e.slug) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    const panel = document.createElement('div');
    panel.className = 'crd-panel-box';
    panel.innerHTML = `
      <h3 class="crd-panel-title">Most read</h3>
      <p class="crd-panel-desc">By chapters opened</p>
    `;

    if (top.length === 0) {
      panel.insertAdjacentHTML('beforeend', `<p class="crd-duo-empty">Nothing logged yet.</p>`);
      return panel;
    }

    const max = top[0][1];
    top.forEach(([slug, count], i) => {
      const mapping = mappingBySlug.get(slug) ?? null;
      const title = entryTitle(mapping, slug);

      const row = document.createElement('button');
      row.className = 'crd-rank-row';
      row.title = 'Open details';

      const n = document.createElement('span');
      n.className = 'crd-rank-n';
      n.textContent = String(i + 1);

      const thumb = document.createElement('span');
      thumb.className = 'crd-rank-thumb';
      const letter = document.createElement('span');
      letter.textContent = title.slice(0, 1).toUpperCase();
      thumb.appendChild(letter);

      const main = document.createElement('span');
      main.className = 'crd-rank-main';
      const t = document.createElement('span');
      t.className = 'crd-rank-title';
      t.textContent = title;
      const bar = document.createElement('span');
      bar.className = 'crd-rank-bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.max(4, Math.round((count / max) * 100))}%`;
      bar.appendChild(fill);
      main.append(t, bar);

      const c = document.createElement('span');
      c.className = 'crd-rank-count';
      c.textContent = `${count} ch`;

      row.append(n, thumb, main, c);
      row.addEventListener('click', () => { window.location.hash = detailsHash(slug); });
      panel.appendChild(row);

      void this.hydrateRankThumb(thumb, mapping);
    });

    return panel;
  }

  private buildRecordsPanel(allDaily: Record<string, DailyStats>, chaptersRead: number, firstTrackedAt: number): HTMLElement {
    const isActive = (d: DailyStats | undefined) => !!d && (d.opened > 0 || d.read > 0 || d.activeSec >= 60);

    // Longest streak: walk the sorted active days looking for consecutive runs
    const activeKeys = Object.entries(allDaily).filter(([, d]) => isActive(d)).map(([k]) => k).sort();
    let longest = 0;
    let run = 0;
    let prev: Date | null = null;
    for (const key of activeKeys) {
      const [y, m, d] = key.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      run = prev !== null && (date.getTime() - prev.getTime()) <= 90_000_000 ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = date;
    }

    let biggest = 0;
    let biggestKey = '';
    for (const [key, d] of Object.entries(allDaily)) {
      if (d.read > biggest) { biggest = d.read; biggestKey = key; }
    }

    const panel = document.createElement('div');
    panel.className = 'crd-panel-box';
    panel.innerHTML = `
      <h3 class="crd-panel-title">Records</h3>
      <p class="crd-panel-desc">All time</p>
    `;

    const rows: Array<{ label: string; value: string; extra?: string }> = [
      { label: 'Longest streak', value: `${longest}`, extra: longest === 1 ? 'day' : 'days' },
      { label: 'Biggest day', value: `${biggest}`, extra: biggestKey ? `chapters · ${fmtDayKey(biggestKey)}` : 'chapters' },
      { label: 'Days active', value: `${activeKeys.length}`, extra: activeKeys.length === 1 ? 'day' : 'days' },
      { label: 'Reading since', value: firstTrackedAt ? new Date(firstTrackedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'today' },
    ];
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'crd-rec-row';
      const label = document.createElement('span');
      label.className = 'crd-rec-label';
      label.textContent = r.label;
      const value = document.createElement('span');
      value.className = 'crd-rec-value';
      value.textContent = r.value;
      if (r.extra) {
        const small = document.createElement('small');
        small.textContent = r.extra;
        value.appendChild(small);
      }
      row.append(label, value);
      panel.appendChild(row);
    }

    // Next milestone meter
    const next = MILESTONES.find((m) => m > chaptersRead);
    const nextEl = document.createElement('div');
    nextEl.className = 'crd-rec-next';
    if (next) {
      nextEl.innerHTML = `
        <div class="crd-rec-next-label"><span>Next milestone: <b>${next} chapters</b></span><span>${chaptersRead} / ${next}</span></div>
        <div class="crd-meter"><span style="width:${Math.min(100, Math.round((chaptersRead / next) * 100))}%"></span></div>
      `;
    } else {
      nextEl.innerHTML = `<div class="crd-rec-next-label"><span>Every milestone cleared. <b>${chaptersRead} chapters.</b></span></div>`;
    }
    panel.appendChild(nextEl);

    return panel;
  }

  // ── Shared single-series bar chart ─────────────────────────────────────────

  private renderBars(hostEl: HTMLElement, opts: {
    values: number[];
    ariaLabel: string;
    gridLabel: (v: number) => string;
    xLabel: (i: number) => string;
    tip: (i: number) => { big: string; small: string };
    summary?: string;
    height?: number;
  }): void {
    const max = Math.max(...opts.values);

    const chart = document.createElement('div');
    chart.className = 'crd-chart';
    if (opts.height) chart.style.height = `${opts.height}px`;
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', opts.ariaLabel);

    // Recessive grid: baseline + max + midpoint
    const gridlines = max > 0
      ? [{ frac: 0, label: opts.gridLabel(max) }, { frac: 0.5, label: max > 1 ? opts.gridLabel(Math.round(max / 2)) : '' }, { frac: 1, label: '' }]
      : [{ frac: 1, label: '' }];
    const grid = document.createElement('div');
    grid.className = 'crd-chart-grid';
    grid.innerHTML = gridlines.map((g) => `
      <div class="crd-chart-gridline" style="top:${g.frac * 100}%">${g.label ? `<em>${g.label}</em>` : ''}</div>
    `).join('');
    chart.appendChild(grid);

    const bars = document.createElement('div');
    bars.className = 'crd-chart-bars';
    opts.values.forEach((value, i) => {
      const col = document.createElement('div');
      col.className = 'crd-bar-col';
      const heightPct = max > 0 ? (value / max) * 100 : 0;
      col.innerHTML = `<div class="crd-bar${value === 0 ? ' zero' : ''}" style="height:${Math.max(heightPct, 1.5)}%"></div>`;
      col.addEventListener('mouseenter', () => {
        chart.querySelector('.crd-chart-tip')?.remove();
        const tipData = opts.tip(i);
        const tip = document.createElement('div');
        tip.className = 'crd-chart-tip';
        const b = document.createElement('b');
        b.textContent = tipData.big;
        const em = document.createElement('em');
        em.textContent = tipData.small;
        tip.append(b, em);
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

    const xAxis = document.createElement('div');
    xAxis.className = 'crd-chart-x';
    xAxis.innerHTML = opts.values.map((_, i) => `<span>${opts.xLabel(i)}</span>`).join('');
    chart.appendChild(xAxis);

    hostEl.appendChild(chart);

    if (opts.summary) {
      const summary = document.createElement('div');
      summary.className = 'crd-chart-summary';
      summary.textContent = opts.summary;
      hostEl.appendChild(summary);
    }
  }

  private async hydrateRankThumb(thumb: HTMLElement, mapping: MangaSourceMapping | null): Promise<void> {
    const sel = selectedSourceOf(mapping);
    if (!sel) return;
    const cacheKey = `${sel.sourceId}/${sel.sourceSlug}`;
    let dataUrl = this.coverCache.get(cacheKey);
    if (dataUrl === undefined) {
      dataUrl = await getCoverDataUrl(sel.sourceId, sel.sourceSlug);
      this.coverCache.set(cacheKey, dataUrl);
    }
    if (!dataUrl) return;
    const img = document.createElement('img');
    img.alt = '';
    img.src = dataUrl;
    img.addEventListener('load', () => {
      thumb.textContent = '';
      thumb.appendChild(img);
    }, { once: true });
  }
}
