import RAPIER from '@dimforge/rapier3d-compat';
import type { TerrainData } from './terrain';

/**
 * Ensures the Rapier WASM module is initialized. Must be awaited once before any
 * other Rapier API is used.
 */
export async function initPhysics(): Promise<void> {
  await RAPIER.init();
}

export interface PhysicsWorld {
  world: RAPIER.World;
  /** Fixed step used by {@link step}. */
  fixedTimeStep: number;
  /** Advance the simulation by `dtSeconds`, using an accumulator for stability. */
  step(dtSeconds: number): void;
}

/**
 * Creates the Rapier world and a static heightfield collider matching the
 * terrain exactly (same CPU height array, same world extent).
 *
 * Rapier heightfield layout (documented convention):
 *  - grid of (nrows+1) x (ncols+1) vertices, subdivided into nrows x ncols quads
 *  - vertex (row i, col j): x = (j/ncols - 0.5)*scale.x, z = (i/nrows - 0.5)*scale.z,
 *    y = heights[i + j*(nrows+1)] * scale.y   (column-major)
 *  - centered at the collider translation
 *
 * Our terrain array is row-major `heights[z*res + x]` and centered at the world
 * origin, so we transpose it into Rapier's column-major order and place the
 * collider at the origin.
 */
export function createPhysicsWorld(terrain: TerrainData): PhysicsWorld {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const res = terrain.resolution;
  const nrows = res - 1;
  const ncols = res - 1;

  // Transpose row-major (z*res + x) -> Rapier column-major (i + j*(nrows+1)).
  // Rapier row i maps to Z, col j maps to X.
  const rapierHeights = new Float32Array(res * res);
  for (let i = 0; i < res; i++) {
    for (let j = 0; j < res; j++) {
      // world grid: z = i, x = j
      rapierHeights[i + j * res] = terrain.heights[i * res + j];
    }
  }

  const scale = new RAPIER.Vector3(terrain.worldSize, terrain.heightScale, terrain.worldSize);
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const groundCollider = RAPIER.ColliderDesc.heightfield(nrows, ncols, rapierHeights, scale).setFriction(1.0);
  world.createCollider(groundCollider, groundBody);

  const fixedTimeStep = 1 / 60;
  world.timestep = fixedTimeStep;

  let accumulator = 0;
  const step = (dtSeconds: number) => {
    // Clamp to avoid a spiral of death after a long stall (e.g. tab switch).
    accumulator += Math.min(dtSeconds, 0.1);
    let iterations = 0;
    while (accumulator >= fixedTimeStep && iterations < 5) {
      world.step();
      accumulator -= fixedTimeStep;
      iterations++;
    }
  };

  return { world, fixedTimeStep, step };
}

export { RAPIER };
