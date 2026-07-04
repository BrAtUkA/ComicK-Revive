import { statsManager } from '@/core';

/**
 * StatsTracker - Active reading time measurement (viewer context)
 *
 * Counts a second as "active" only while the tab is visible and the user
 * has interacted (wheel / key / pointer / touch) within the last
 * IDLE_CUTOFF_MS. Accumulated time is flushed to statsManager every
 * FLUSH_INTERVAL_MS and on stop(), so a crash loses at most one flush
 * window of data.
 */

const TICK_MS = 5_000;
const IDLE_CUTOFF_MS = 45_000;
const FLUSH_INTERVAL_MS = 30_000;

// Capture-phase on window so we see interactions regardless of which
// scroll container or overlay the reader is using.
const ACTIVITY_EVENTS = ['wheel', 'keydown', 'pointerdown', 'touchmove'] as const;

export class StatsTracker {
  private comickSlug: string | null = null;
  private lastActivity = 0;
  private pendingSec = 0;
  private sinceFlushMs = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onActivity = (): void => {
    this.lastActivity = Date.now();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      // Flush eagerly — the tab may be closing and this is our last chance
      void this.flush();
    }
  };

  start(comickSlug: string): void {
    this.stopTimers();
    this.comickSlug = comickSlug;
    this.lastActivity = Date.now();  // opening the viewer is itself activity
    this.pendingSec = 0;
    this.sinceFlushMs = 0;

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, this.onActivity, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Stop tracking and flush whatever is pending. */
  async stop(): Promise<void> {
    this.stopTimers();
    for (const event of ACTIVITY_EVENTS) {
      window.removeEventListener(event, this.onActivity, { capture: true });
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    await this.flush();
    this.comickSlug = null;
  }

  private tick(): void {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - this.lastActivity > IDLE_CUTOFF_MS) return;

    this.pendingSec += TICK_MS / 1000;
    this.sinceFlushMs += TICK_MS;
    if (this.sinceFlushMs >= FLUSH_INTERVAL_MS) {
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    const seconds = this.pendingSec;
    if (seconds <= 0 || !this.comickSlug) return;
    this.pendingSec = 0;
    this.sinceFlushMs = 0;
    await statsManager.addActiveTime(seconds, this.comickSlug);
  }

  private stopTimers(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}

export const statsTracker = new StatsTracker();
