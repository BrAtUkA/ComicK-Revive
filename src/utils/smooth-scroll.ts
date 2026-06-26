/**
 * SmoothScroller - Custom RAF-based smooth scrolling with accumulation
 *
 * Two modes:
 * 1. Remaining mode (tap): exponential ease-out drains a finite distance.
 * 2. Velocity mode (hold): constant px/sec scroll, stops with brief settle on release.
 */
export class SmoothScroller {
  private container: HTMLElement | null = null;
  private remaining: number = 0;
  private rafId: number | null = null;
  private lastTime: number = 0;

  /** Smoothing factor for remaining mode. Higher = snappier, lower = more glide. */
  private smoothing = 0.15;

  /** Below this threshold (px), snap to final position and stop. */
  private readonly epsilon = 0.5;

  /** Constant scroll velocity in px/sec. Non-zero = velocity mode active. */
  private velocity: number = 0;

  /** How many ms of velocity to convert into settle distance on stop. */
  private readonly STOP_SETTLE_MS = 80;

  /** Set the smoothing factor. Higher = snappier, lower = more glide. */
  setSmoothing(value: number): void {
    this.smoothing = Math.max(0.02, Math.min(0.35, value));
  }

  attach(container: HTMLElement): void {
    this.container = container;
    this.stop();
  }

  detach(): void {
    this.stop();
    this.container = null;
  }

  /**
   * Scroll by a given number of pixels (positive = down, negative = up).
   * If an animation is already running, the delta is added to the remaining distance.
   * Accumulation is capped at 2× the delta to prevent runaway from rapid taps.
   */
  scrollBy(delta: number): void {
    if (!this.container) return;

    // Cancel velocity mode if active (tap interrupts hold)
    if (this.velocity !== 0) {
      this.velocity = 0;
    }

    this.remaining += delta;

    // Cap accumulation to prevent runaway from rapid taps
    const maxRemaining = Math.abs(delta) * 2;
    this.remaining = Math.max(-maxRemaining, Math.min(maxRemaining, this.remaining));

    // Clamp to scroll bounds
    const maxDown = this.container.scrollHeight - this.container.clientHeight - this.container.scrollTop;
    const maxUp = -this.container.scrollTop;
    this.remaining = Math.max(maxUp, Math.min(maxDown, this.remaining));

    if (this.rafId === null) {
      this.lastTime = performance.now();
      this.tick();
    }
  }

  /**
   * Immediately scroll to a specific position with animation.
   */
  scrollTo(target: number): void {
    if (!this.container) return;
    this.velocity = 0;
    const current = this.container.scrollTop;
    this.remaining = target - current;
    if (this.rafId === null) {
      this.lastTime = performance.now();
      this.tick();
    }
  }

  /**
   * Begin scrolling at a constant velocity (px/sec).
   * Positive = down, negative = up.
   */
  startContinuousScroll(pixelsPerSecond: number): void {
    if (!this.container) return;

    this.velocity = pixelsPerSecond;
    this.remaining = 0;

    if (this.rafId === null) {
      this.lastTime = performance.now();
      this.tick();
    }
  }

  /**
   * Stop continuous scrolling with a brief settle.
   */
  stopContinuousScroll(): void {
    if (this.velocity === 0) return;

    // Convert a fraction of current velocity into remaining for smooth stop
    this.remaining = this.velocity * (this.STOP_SETTLE_MS / 1000);
    this.velocity = 0;
    // RAF loop is already running — it will drain remaining naturally
  }

  /** Stop any in-progress animation immediately. */
  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.remaining = 0;
    this.velocity = 0;
  }

  private tick = (): void => {
    if (!this.container) {
      this.velocity = 0;
      this.remaining = 0;
      this.rafId = null;
      return;
    }

    const now = performance.now();
    const dt = now - this.lastTime;
    this.lastTime = now;

    if (this.velocity !== 0) {
      // Velocity mode: constant speed
      let step = this.velocity * (dt / 1000);

      // Clamp to scroll bounds
      const maxDown = this.container.scrollHeight - this.container.clientHeight - this.container.scrollTop;
      const maxUp = -this.container.scrollTop;
      step = Math.max(maxUp, Math.min(maxDown, step));

      this.container.scrollTop += step;
      this.rafId = requestAnimationFrame(this.tick);

    } else if (Math.abs(this.remaining) >= this.epsilon) {
      // Remaining mode: exponential ease-out
      const factor = 1 - Math.pow(1 - this.smoothing, dt / 16);
      const step = this.remaining * factor;

      this.container.scrollTop += step;
      this.remaining -= step;

      this.rafId = requestAnimationFrame(this.tick);

    } else {
      // Below epsilon: snap and stop
      if (Math.abs(this.remaining) > 0) {
        this.container.scrollTop += this.remaining;
      }
      this.remaining = 0;
      this.rafId = null;
    }
  };
}
