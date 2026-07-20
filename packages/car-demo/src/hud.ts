/**
 * Minimal heads-up display: shows speed in km/h and hides the loading overlay.
 * Reads the DOM elements declared in index.html.
 */
export class Hud {
  private readonly _speedEl: HTMLElement | null;
  private readonly _loadingEl: HTMLElement | null;
  private _lastShown: number;

  constructor() {
    this._speedEl = document.getElementById('speed');
    this._loadingEl = document.getElementById('loading');
    this._lastShown = -1;
  }

  /** Removes the loading overlay once the scene is ready. */
  hideLoading() {
    if (this._loadingEl) {
      this._loadingEl.style.display = 'none';
    }
  }

  /** Updates the speed readout. `speedMetresPerSec` from the vehicle. */
  setSpeed(speedMetresPerSec: number) {
    const kmh = Math.round(speedMetresPerSec * 3.6);
    if (kmh !== this._lastShown && this._speedEl) {
      this._speedEl.textContent = String(kmh);
      this._lastShown = kmh;
    }
  }
}
