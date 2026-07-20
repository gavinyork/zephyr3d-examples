import { getInput } from '@zephyr3d/scene';

/** Normalized driver input consumed by the vehicle each frame. */
export interface VehicleInput {
  /** 0..1 forward throttle. */
  throttle: number;
  /** 0..1 foot brake / reverse. */
  brake: number;
  /** −1..1 steering (−1 = left, +1 = right). */
  steer: number;
  /** Handbrake engaged. */
  handbrake: boolean;
}

/**
 * Tracks raw key state via an input middleware and derives a {@link VehicleInput}
 * on demand. Uses `KeyboardEvent.code` so it is layout-independent.
 */
export class InputController {
  private readonly _keys: Set<string>;
  readonly value: VehicleInput;

  constructor() {
    this._keys = new Set();
    this.value = { throttle: 0, brake: 0, steer: 0, handbrake: false };

    getInput().use((ev: Event) => {
      if (ev.type === 'keydown') {
        this._keys.add((ev as KeyboardEvent).code);
        return true;
      }
      if (ev.type === 'keyup') {
        this._keys.delete((ev as KeyboardEvent).code);
        return true;
      }
      return false;
    });
  }

  private _has(...codes: string[]): boolean {
    for (const c of codes) {
      if (this._keys.has(c)) {
        return true;
      }
    }
    return false;
  }

  /** Recompute the derived input from current key state. Call once per frame. */
  update(): VehicleInput {
    const forward = this._has('KeyW', 'ArrowUp');
    const back = this._has('KeyS', 'ArrowDown');
    const left = this._has('KeyA', 'ArrowLeft');
    const right = this._has('KeyD', 'ArrowRight');

    this.value.throttle = forward ? 1 : 0;
    this.value.brake = back ? 1 : 0;
    this.value.steer = (left ? -1 : 0) + (right ? 1 : 0);
    this.value.handbrake = this._has('Space');
    return this.value;
  }
}
