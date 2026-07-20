import { Quaternion, Vector3 } from '@zephyr3d/base';
import { BaseCameraController } from '@zephyr3d/scene';
import type { PerspectiveCamera } from '@zephyr3d/scene';

/** Provides the follow target's world transform each frame. */
export interface ChaseTarget {
  getPosition(out: Vector3): Vector3;
  getRotation(out: Quaternion): Quaternion;
  /** Forward speed in m/s, used to widen FOV at speed. */
  readonly speed: number;
}

export interface ChaseCameraOptions {
  /** Offset behind (−Z local) and above the target, in target-local space. */
  distance?: number;
  height?: number;
  /** Look-at point height above the target origin. */
  lookHeight?: number;
  /** Positional smoothing (higher = snappier). */
  stiffness?: number;
  baseFovY?: number;
  maxFovBoost?: number;
}

const tgtPos = new Vector3();
const tgtRot = new Quaternion();
const localOffset = new Vector3();
const desiredPos = new Vector3();
const lookAt = new Vector3();
const up = Vector3.axisPY();

/**
 * Third-person chase camera with damped follow and speed-driven FOV.
 * Put the follow math in `_onUpdate`, invoked each frame by `camera.updateController()`.
 */
export class ChaseCameraController extends BaseCameraController {
  private readonly _target: ChaseTarget;
  private readonly _distance: number;
  private readonly _height: number;
  private readonly _lookHeight: number;
  private readonly _stiffness: number;
  private readonly _baseFovY: number;
  private readonly _maxFovBoost: number;
  private readonly _currentPos: Vector3;
  private _initialized: boolean;
  private _deltaTime: number;

  constructor(target: ChaseTarget, options?: ChaseCameraOptions) {
    super();
    this._target = target;
    this._distance = options?.distance ?? 7;
    this._height = options?.height ?? 3;
    this._lookHeight = options?.lookHeight ?? 1.2;
    this._stiffness = options?.stiffness ?? 4;
    this._baseFovY = options?.baseFovY ?? Math.PI / 4;
    this._maxFovBoost = options?.maxFovBoost ?? Math.PI / 12;
    this._currentPos = new Vector3();
    this._initialized = false;
    this._deltaTime = 1 / 60;
  }

  /** Set the frame delta (seconds) before calling `camera.updateController()`. */
  setDeltaTime(dt: number) {
    this._deltaTime = dt;
  }

  reset() {
    this._initialized = false;
  }

  protected _onUpdate() {
    const deltaTimeInSeconds = this._deltaTime;
    const camera = this._getCamera() as PerspectiveCamera;
    if (!camera) {
      return;
    }

    this._target.getPosition(tgtPos);
    this._target.getRotation(tgtRot);

    // Desired camera position = target + rotated (behind & above) offset.
    // Target forward is +Z local; camera sits at −Z (behind) and +Y (above).
    localOffset.setXYZ(0, this._height, -this._distance);
    tgtRot.transform(localOffset, localOffset);
    desiredPos.setXYZ(tgtPos.x + localOffset.x, tgtPos.y + localOffset.y, tgtPos.z + localOffset.z);

    if (!this._initialized) {
      this._currentPos.set(desiredPos);
      this._initialized = true;
    } else {
      // Exponential smoothing, frame-rate independent.
      const t = 1 - Math.exp(-this._stiffness * Math.max(deltaTimeInSeconds, 0.0001));
      this._currentPos.x += (desiredPos.x - this._currentPos.x) * t;
      this._currentPos.y += (desiredPos.y - this._currentPos.y) * t;
      this._currentPos.z += (desiredPos.z - this._currentPos.z) * t;
    }

    lookAt.setXYZ(tgtPos.x, tgtPos.y + this._lookHeight, tgtPos.z);
    camera.lookAt(this._currentPos, lookAt, up);

    // Speed -> FOV. Ramp from base to base+boost over 0..40 m/s.
    const k = Math.min(1, this._target.speed / 40);
    camera.fovY = this._baseFovY + this._maxFovBoost * k;
  }
}
