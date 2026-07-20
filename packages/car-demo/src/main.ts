import { Vector3, Vector4 } from '@zephyr3d/base';
import { backendWebGL2 } from '@zephyr3d/backend-webgl';
import {
  Application,
  DirectionalLight,
  FBMWaveGenerator,
  getEngine,
  getInput,
  PerspectiveCamera,
  Scene,
  Water
} from '@zephyr3d/scene';
import { createTerrain } from './terrain';
import { initPhysics, createPhysicsWorld } from './physics';
import { Vehicle } from './vehicle';
import { ChaseCameraController } from './chase-camera';
import { InputController } from './input';
import { Hud } from './hud';

// Rapier WASM must be initialized before any physics API is used.
await initPhysics();

const app = new Application({
  canvas: document.querySelector<HTMLCanvasElement>('#canvas'),
  backend: backendWebGL2
});

await app.ready();

const scene = new Scene();

// --- Environment: dusk scatter sky + image-based lighting ---
scene.env.sky.skyType = 'scatter';
scene.env.sky.cloudy = 0.4;
scene.env.sky.fogType = 'height_fog';
scene.env.light.type = 'ibl'; // scene auto-syncs IBL maps from the sky each frame

// Sun (first directional light becomes the scene sun automatically).
const sun = new DirectionalLight(scene);
sun.lookAt(new Vector3(-6, 5, -4), Vector3.zero(), Vector3.axisPY());
sun.color = new Vector4(1.0, 0.85, 0.7, 1);
sun.intensity = 8;
sun.castShadow = true;
sun.shadow.mode = 'pcf';
sun.shadow.depthBias = 0.1;
sun.shadow.numShadowCascades = 4;
sun.shadow.shadowDistance = 50;

// --- Terrain (render) + physics heightfield from the same CPU heights ---
const terrainData = createTerrain(scene, 256, 400, 40);
const physics = createPhysicsWorld(terrainData);

// --- Water ring around the terrain, slightly above the basin floor ---
const water = new Water(scene);
water.scale.setXYZ(terrainData.worldSize, 1, terrainData.worldSize);
water.position.setXYZ(0, terrainData.heightScale * 0.2, 0);
water.waveGenerator = new FBMWaveGenerator();

// --- Vehicle: spawn above the terrain centre so it drops onto the ground ---
const spawnH = terrainData.sampleHeight(0, 0) + 3;
const vehicle = new Vehicle(scene, physics, new Vector3(0, spawnH, 0));

// --- Camera: third-person chase with damped follow + speed FOV ---
const camera = new PerspectiveCamera(scene, Math.PI / 4, 0.25, 2000);
camera.FXAA = true;
//camera.toneMap = true;
//camera.bloom = true;
//scene.mainCamera = camera;
const chase = new ChaseCameraController(vehicle, { distance: 8, height: 3.2 });
camera.controller = chase;
// Keep the input->camera channel consistent with other demos.
getInput().use(camera.handleEvent, camera);

// --- Input + HUD ---
const input = new InputController();
const hud = new Hud();
hud.hideLoading();

getEngine().setRenderable(scene, 0);

app.on('tick', (deltaMs: number) => {
  const dt = Math.min(deltaMs, 100) / 1000;

  const cmd = input.update();
  vehicle.applyInput(cmd);

  // Fixed-step physics, then advance the controller and sync render nodes.
  physics.step(dt);
  vehicle.update(dt);
  vehicle.syncTransforms();

  // Camera smoothing uses this frame's dt; scene.frameUpdate() calls updateController().
  chase.setDeltaTime(dt);

  hud.setSpeed(vehicle.speed);
});

app.run();
