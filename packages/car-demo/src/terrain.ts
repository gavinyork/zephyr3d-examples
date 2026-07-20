import { float2half } from '@zephyr3d/base';
import type { Texture2D } from '@zephyr3d/device';
import { getDevice, getEngine } from '@zephyr3d/scene';
import type { Scene } from '@zephyr3d/scene';
import { ClipmapTerrain } from '@zephyr3d/scene';

/**
 * Result of {@link createTerrain}. The CPU-side height data is the single source
 * of truth shared by both the renderer (uploaded to the GPU height texture) and
 * the physics engine (fed to a Rapier heightfield collider).
 */
export interface TerrainData {
  terrain: ClipmapTerrain;
  /** Grid resolution (heights.length === resolution * resolution). */
  resolution: number;
  /** World-space extent of the terrain on X and Z (square). */
  worldSize: number;
  /** Vertical scale applied to the raw height values (node scale.y). */
  heightScale: number;
  /**
   * Raw height values in grid order, row index `z * resolution + x`, each in the
   * range roughly [0, 1] before `heightScale` is applied. This is the exact array
   * shared with the physics heightfield.
   */
  heights: Float32Array;
  /** Bilinear height query in world space (already includes heightScale). */
  sampleHeight(worldX: number, worldZ: number): number;
}

/**
 * Value-noise based fractal terrain. Deterministic (seeded) so the physics and
 * render sides always agree, and so reloads are reproducible.
 */
function buildHeightField(resolution: number): Float32Array {
  const heights = new Float32Array(resolution * resolution);

  // Simple seeded hash -> [0,1) value noise, then fbm over several octaves.
  const hash = (ix: number, iz: number) => {
    let h = ix * 374761393 + iz * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    h = h ^ (h >> 16);
    return (h >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const valueNoise = (x: number, z: number) => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = smooth(x - x0);
    const fz = smooth(z - z0);
    const v00 = hash(x0, z0);
    const v10 = hash(x0 + 1, z0);
    const v01 = hash(x0, z0 + 1);
    const v11 = hash(x0 + 1, z0 + 1);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fz;
  };

  let min = Infinity;
  let max = -Infinity;
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const nx = x / resolution;
      const nz = z / resolution;
      let amp = 1;
      let freq = 3;
      let sum = 0;
      let norm = 0;
      for (let o = 0; o < 5; o++) {
        sum += valueNoise(nx * freq, nz * freq) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      let h = sum / norm;
      // Carve a gentle flat-ish basin in the centre so the car has room to spawn
      // and a rim of hills around the edges.
      const cx = nx - 0.5;
      const cz = nz - 0.5;
      const rim = Math.min(1, (cx * cx + cz * cz) * 4);
      h = h * (0.35 + 0.65 * rim);
      heights[z * resolution + x] = h;
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  // Normalize to [0,1] for predictable vertical scaling.
  const range = max - min || 1;
  for (let i = 0; i < heights.length; i++) {
    heights[i] = (heights[i] - min) / range;
  }
  return heights;
}

/**
 * Creates the terrain node, uploads the CPU height field to its GPU height
 * texture (half-float encoded), and returns the shared data used by physics.
 */
export function createTerrain(
  scene: Scene,
  resolution = 256,
  worldSize = 400,
  heightScale = 40
): TerrainData {
  const heights = buildHeightField(resolution);

  const terrain = new ClipmapTerrain(scene, resolution, resolution);
  // World Y = heightTexel * scale.y. Scale X/Z so the (resolution x resolution)
  // grid spans `worldSize` world units.
  const gridToWorld = worldSize / resolution;
  terrain.scale.setXYZ(gridToWorld, heightScale, gridToWorld);
  // Centre the terrain on the world origin.
  terrain.position.setXYZ(-worldSize * 0.5, 0, -worldSize * 0.5);

  // Upload heights to the GPU height texture (red channel, half-float).
  const device = getDevice();
  const format = device.type === 'webgl' ? 'rgba16f' : 'r16f';
  const tex = device.createTexture2D(format, resolution, resolution)!;
  tex.name = 'CarDemoTerrainHeight';
  if (format === 'r16f') {
    const half = new Uint16Array(resolution * resolution);
    for (let i = 0; i < half.length; i++) {
      half[i] = float2half(heights[i]);
    }
    tex.update(half, 0, 0, resolution, resolution);
  } else {
    // WebGL1 fallback: replicate into the red channel of an rgba16f texture.
    const half = new Uint16Array(resolution * resolution * 4);
    for (let i = 0; i < heights.length; i++) {
      half[i * 4] = float2half(heights[i]);
    }
    tex.update(half, 0, 0, resolution, resolution);
  }
  terrain.heightMap = tex;
  terrain.updateBoundingBox();
  terrain.castShadow = true;
  Promise.all([
    getEngine().resourceManager.fetchTexture<Texture2D>(
      'https://cdn.zephyr3d.org/demos/walking/assets/images/detail1.jpg',
      { linearColorSpace: false }
    ),
    getEngine().resourceManager.fetchTexture<Texture2D>(
      'https://cdn.zephyr3d.org/demos/walking/assets/images/detail1_norm.jpg',
      { linearColorSpace: true }
    )
  ]).then((t) => {
    terrain.numDetailMaps = 1;
    terrain.material.setDetailMap(0, t[0]);
    terrain.material.setDetailNormalMap(0, t[1]);
    terrain.material.setDetailMapUVScale(0, 50);
  });

  const sampleHeight = (worldX: number, worldZ: number): number => {
    // World -> grid coordinates.
    const gx = (worldX - terrain.position.x) / gridToWorld;
    const gz = (worldZ - terrain.position.z) / gridToWorld;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const clamp = (v: number) => Math.max(0, Math.min(resolution - 1, v));
    const x1 = clamp(x0 + 1);
    const z1 = clamp(z0 + 1);
    const cx0 = clamp(x0);
    const cz0 = clamp(z0);
    const fx = gx - x0;
    const fz = gz - z0;
    const h00 = heights[cz0 * resolution + cx0];
    const h10 = heights[cz0 * resolution + x1];
    const h01 = heights[z1 * resolution + cx0];
    const h11 = heights[z1 * resolution + x1];
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return (a + (b - a) * fz) * heightScale;
  };

  return { terrain, resolution, worldSize, heightScale, heights, sampleHeight };
}
