import { Quaternion, Vector3, Vector4 } from '@zephyr3d/base';
import { BoxShape, CylinderShape, Mesh, PBRMetallicRoughnessMaterial } from '@zephyr3d/scene';
import type { Scene, SceneNode } from '@zephyr3d/scene';
import { RAPIER } from './physics';
import type { PhysicsWorld } from './physics';
import type { VehicleInput } from './input';

// Chassis half-extents (metres).
const CHASSIS_HALF = { x: 0.9, y: 0.35, z: 1.9 };
const WHEEL_RADIUS = 0.4;
const WHEEL_WIDTH = 0.3;
const SUSPENSION_REST = 0.35;
const MAX_STEER = 0.5; // radians
const ENGINE_FORCE = 1400;
const BRAKE_FORCE = 80;
const HANDBRAKE_FORCE = 150;

// Wheel connection points relative to the chassis centre of mass.
const WHEEL_POSITIONS = [
  { x: -CHASSIS_HALF.x, y: -0.1, z: CHASSIS_HALF.z - 0.4, steer: true }, // front-left
  { x: CHASSIS_HALF.x, y: -0.1, z: CHASSIS_HALF.z - 0.4, steer: true }, // front-right
  { x: -CHASSIS_HALF.x, y: -0.1, z: -CHASSIS_HALF.z + 0.4, steer: false }, // rear-left
  { x: CHASSIS_HALF.x, y: -0.1, z: -CHASSIS_HALF.z + 0.4, steer: false } // rear-right
];

const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const wheelSpin = new Quaternion();
const steerQuat = new Quaternion();

export class Vehicle {
  private readonly _chassis: RAPIER.RigidBody;
  private readonly _controller: RAPIER.DynamicRayCastVehicleController;
  private readonly _chassisNode: Mesh;
  private readonly _wheelNodes: SceneNode[];
  private readonly _wheelSpin: number[];

  constructor(scene: Scene, physics: PhysicsWorld, spawn: Vector3) {
    // --- Physics: chassis rigid body + collider ---
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(0.15)
      .setAngularDamping(0.6)
      // Lower the centre of mass to resist rolling over.
      .setAdditionalMass(0);
    this._chassis = physics.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(CHASSIS_HALF.x, CHASSIS_HALF.y, CHASSIS_HALF.z)
      .setMass(1000)
      .setFriction(0.8);
    physics.world.createCollider(colliderDesc, this._chassis);

    // --- Raycast vehicle controller ---
    this._controller = physics.world.createVehicleController(this._chassis);
    this._controller.indexUpAxis = 1; // Y up
    this._controller.setIndexForwardAxis = 2; // Z forward

    const down = new RAPIER.Vector3(0, -1, 0);
    const axle = new RAPIER.Vector3(-1, 0, 0);
    for (const w of WHEEL_POSITIONS) {
      this._controller.addWheel(new RAPIER.Vector3(w.x, w.y, w.z), down, axle, SUSPENSION_REST, WHEEL_RADIUS);
    }
    const wheelCount = WHEEL_POSITIONS.length;
    for (let i = 0; i < wheelCount; i++) {
      this._controller.setWheelSuspensionStiffness(i, 24);
      this._controller.setWheelSuspensionCompression(i, 0.82);
      this._controller.setWheelSuspensionRelaxation(i, 0.88);
      this._controller.setWheelMaxSuspensionTravel(i, 0.5);
      this._controller.setWheelFrictionSlip(i, 2.0);
      this._controller.setWheelSideFrictionStiffness(i, 0.9);
    }

    // --- Render: chassis + wheels ---
    const paint = new PBRMetallicRoughnessMaterial();
    paint.albedoColor = new Vector4(0.75, 0.05, 0.08, 1);
    paint.metallic = 0.9;
    paint.roughness = 0.28;
    paint.clearcoat = true;
    paint.clearcoatIntensity = 1;
    paint.clearcoatRoughnessFactor = 0.08;
    this._chassisNode = new Mesh(
      scene,
      new BoxShape({
        sizeX: CHASSIS_HALF.x * 2,
        sizeY: CHASSIS_HALF.y * 2,
        sizeZ: CHASSIS_HALF.z * 2,
        anchor: 0.5
      }),
      paint
    );
    this._chassisNode.castShadow = true;

    const rubber = new PBRMetallicRoughnessMaterial();
    rubber.albedoColor = new Vector4(0.05, 0.05, 0.06, 1);
    rubber.metallic = 0.1;
    rubber.roughness = 0.85;

    this._wheelNodes = [];
    for (let i = 0; i < wheelCount; i++) {
      // Cylinder axis is Y; the wheel axle is world X, so pre-rotate 90° about Z.
      const wheel = new Mesh(
        scene,
        new CylinderShape({
          topRadius: WHEEL_RADIUS,
          bottomRadius: WHEEL_RADIUS,
          height: WHEEL_WIDTH,
          anchor: 0.5,
          radialDetail: 24
        }),
        rubber
      );
      wheel.castShadow = true;
      this._wheelNodes.push(wheel);
    }
    this._wheelSpin = new Array(wheelCount).fill(0);
  }

  /** Chassis node */
  get chassisNode(): Mesh {
    return this._chassisNode;
  }
  /** Current forward speed magnitude in m/s. */
  get speed(): number {
    const v = this._chassis.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  /** Applies driver input to the wheels. Call before stepping physics. */
  applyInput(input: VehicleInput) {
    const steer = input.steer * MAX_STEER;
    const engine = input.throttle * ENGINE_FORCE;
    const brake = input.brake * BRAKE_FORCE + (input.handbrake ? HANDBRAKE_FORCE : 0);
    for (let i = 0; i < WHEEL_POSITIONS.length; i++) {
      const w = WHEEL_POSITIONS[i];
      if (w.steer) {
        this._controller.setWheelSteering(i, steer);
      }
      // Rear-wheel drive.
      this._controller.setWheelEngineForce(i, w.steer ? 0 : engine);
      this._controller.setWheelBrake(i, brake);
    }
  }

  /** Steps the vehicle controller. `dt` in seconds. */
  update(dt: number) {
    this._controller.updateVehicle(dt);
  }

  /** Syncs render nodes from the physics state. Call once per frame. */
  syncTransforms() {
    const t = this._chassis.translation();
    const r = this._chassis.rotation();
    this._chassisNode.position.setXYZ(t.x, t.y, t.z);
    this._chassisNode.rotation.setXYZW(r.x, r.y, r.z, r.w);

    const chassisQuat = tmpQuat.setXYZW(r.x, r.y, r.z, r.w);
    for (let i = 0; i < this._wheelNodes.length; i++) {
      const wc = this._controller.wheelChassisConnectionPointCs(i);
      const susp = this._controller.wheelSuspensionLength(i) ?? SUSPENSION_REST;
      const steer = this._controller.wheelSteering(i) ?? 0;
      const rotationRate = this._controller.wheelRotation(i) ?? 0;
      this._wheelSpin[i] = rotationRate;

      // Wheel local position = connection point minus suspension travel on Y.
      const localX = wc?.x ?? 0;
      const localY = (wc?.y ?? 0) - susp;
      const localZ = wc?.z ?? 0;
      tmpPos.setXYZ(localX, localY, localZ);
      // Transform local offset by chassis rotation, add chassis position.
      chassisQuat.transform(tmpPos, tmpPos);
      this._wheelNodes[i].position.setXYZ(t.x + tmpPos.x, t.y + tmpPos.y, t.z + tmpPos.z);

      // Orientation: chassis * steer(Y) * spin(X axle) * axleAlign(Z 90°).
      Quaternion.fromAxisAngle(Vector3.axisPY(), steer, steerQuat);
      Quaternion.fromAxisAngle(Vector3.axisPX(), this._wheelSpin[i], wheelSpin);
      const q = Quaternion.multiply(chassisQuat, steerQuat, new Quaternion());
      q.multiplyRight(wheelSpin);
      // Align cylinder Y-axis to the X axle.
      q.multiplyRight(Quaternion.fromAxisAngle(Vector3.axisPZ(), Math.PI / 2, new Quaternion()));
      this._wheelNodes[i].rotation.setXYZW(q.x, q.y, q.z, q.w);
    }
  }

  /** World-space chassis position (writes into `out`). */
  getPosition(out: Vector3): Vector3 {
    const t = this._chassis.translation();
    return out.setXYZ(t.x, t.y, t.z);
  }

  /** World-space chassis orientation (writes into `out`). */
  getRotation(out: Quaternion): Quaternion {
    const r = this._chassis.rotation();
    return out.setXYZW(r.x, r.y, r.z, r.w);
  }
}
