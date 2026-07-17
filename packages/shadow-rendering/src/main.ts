import { Quaternion, Vector3, Vector4 } from "@zephyr3d/base";
import { backendWebGL1, backendWebGL2 } from "@zephyr3d/backend-webgl";
import { backendWebGPU } from "@zephyr3d/backend-webgpu";
import type { DeviceBackend } from "@zephyr3d/device";
import {
  Application,
  BoxShape,
  CylinderShape,
  DirectionalLight,
  getInput,
  LambertMaterial,
  Mesh,
  OrbitCameraController,
  PerspectiveCamera,
  PlaneShape,
  PointLight,
  Scene,
  SphereShape,
  SpotLight,
  TorusShape,
} from "@zephyr3d/scene";
import type { ShadowMode } from "@zephyr3d/scene";

const SHADOW_MODES = ["hard", "pcf", "pcss", "vsm"] as const;
type DemoShadowMode = (typeof SHADOW_MODES)[number];
type DemoShadowLight = DirectionalLight | PointLight | SpotLight;
type ShadowStation = {
  label: string;
  center: Vector3;
  light: DemoShadowLight;
  blockers: {
    box: Mesh;
    sphere: Mesh;
    torus: Mesh;
  };
};

const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
if (!canvas) {
  throw new Error("Missing canvas element");
}

const app = new Application({
  backend: await getBackend(),
  canvas,
  enableMSAA: true,
});

await app.ready();

const scene = new Scene();
scene.env.light.type = "hemisphere";
scene.env.light.strength = 0.08;
scene.env.sky.fogType = "none";

const camera = new PerspectiveCamera(scene, Math.PI / 3, 0.05, 100);
camera.lookAt(
  new Vector3(0, 5.2, 9.2),
  new Vector3(0, 0.9, 0),
  Vector3.axisPY(),
);
camera.controller = new OrbitCameraController({
  center: new Vector3(0, 0.8, 0),
});
scene.mainCamera = camera;
getInput().use(camera.handleEvent, camera);

const directionalStation = createStation(
  "DirectionalLight",
  new Vector3(-4.6, 0, 0),
  new Vector4(0.86, 0.72, 0.45, 1),
);
const pointStation = createStation(
  "PointLight",
  new Vector3(0, 0, 0),
  new Vector4(0.35, 0.62, 0.95, 1),
);
const spotStation = createStation(
  "SpotLight",
  new Vector3(4.6, 0, 0),
  new Vector4(0.92, 0.46, 0.25, 1),
);

const keyLight = createDirectionalLight([
  directionalStation,
  pointStation,
  spotStation,
]);
const pointLight = createPointLight(pointStation);
const spotLight = createSpotLight(spotStation);
const lights: DemoShadowLight[] = [keyLight, pointLight, spotLight];
const stations: ShadowStation[] = [
  { ...directionalStation, light: keyLight },
  { ...pointStation, light: pointLight },
  { ...spotStation, light: spotLight },
];

const state = {
  shadowEnabled: true,
  mode: "pcf" as DemoShadowMode,
};

wireUi(state, lights);

app.on("resize", (width, height) => {
  camera.aspect = width / height;
});

app.on("tick", (_deltaMs, elapsedMs) => {
  const seconds = elapsedMs / 1000;

  for (let i = 0; i < stations.length; i++) {
    animateStation(stations[i], seconds, i);
  }

  camera.updateController();
  camera.render(scene);

  app.device.drawText(
    "DirectionalLight    PointLight    SpotLight",
    24,
    74,
    "#ffffff",
  );
  app.device.drawText(`Shadow mode: ${state.mode}`, 24, 96, "#dbeafe");
  app.device.drawText(
    `Device: ${app.device.type} | FPS: ${app.device.frameInfo.FPS.toFixed(1)}`,
    24,
    118,
    "#fde68a",
  );
});

app.run();

function createStation(label: string, center: Vector3, accent: Vector4) {
  const floor = createMesh(
    new PlaneShape({ sizeX: 3.5, sizeY: 3.5, resolutionX: 8, resolutionY: 8 }),
    new Vector4(0.36, 0.38, 0.34, 1),
  );
  floor.position.setXYZ(center.x, 0, center.z);
  floor.castShadow = false;

  const pedestal = createMesh(
    new CylinderShape({ height: 0.35, bottomRadius: 0.85, topRadius: 0.72 }),
    new Vector4(0.28, 0.3, 0.36, 1),
  );
  pedestal.position.setXYZ(center.x, 0, center.z);

  const box = createMesh(
    new BoxShape({ size: 0.62 }),
    new Vector4(accent.x, accent.y, accent.z, 1),
  );
  box.position.setXYZ(center.x - 0.78, 0.78, center.z - 0.12);

  const sphere = createMesh(
    new SphereShape({ radius: 0.42 }),
    new Vector4(0.24, 0.55, 0.88, 1),
  );
  sphere.position.setXYZ(center.x, 1.1, center.z + 0.24);

  const torus = createMesh(
    new TorusShape({
      outerRadius: 0.48,
      innerRadius: 0.13,
      numSlices: 48,
      numSegments: 16,
    }),
    new Vector4(0.95, 0.72, 0.3, 1),
  );
  torus.position.setXYZ(center.x + 0.82, 1.18, center.z - 0.08);

  const blockers = [pedestal, box, sphere, torus];
  for (const mesh of blockers) {
    mesh.castShadow = true;
  }

  return {
    label,
    center,
    blockers: {
      box,
      sphere,
      torus,
    },
    allBlockers: blockers,
  };
}

function createDirectionalLight(stations: ReturnType<typeof createStation>[]) {
  const light = new DirectionalLight(scene);
  light
    .setColor(new Vector4(1, 0.96, 0.84, 1))
    .setIntensity(4.5)
    .setCastShadow(true);
  light.lookAt(new Vector3(-2.6, 5.2, 2.3), Vector3.zero(), Vector3.axisPY());
  configureShadow(light);
  for (const station of stations) {
    for (const mesh of station.allBlockers) {
      light.shadow.shadowRegion.addDynamicCaster(mesh);
    }
  }
  return light;
}

function createPointLight(station: ReturnType<typeof createStation>) {
  const light = new PointLight(scene);
  light
    .setColor(new Vector4(0.45, 0.7, 1, 1))
    .setIntensity(9)
    .setRange(4.2)
    .setCastShadow(true);
  light.position.setXYZ(station.center.x, 8.7, station.center.z + 0.15);
  configureShadow(light);
  createLightMarker(light.position, new Vector4(0.45, 1.7, 1, 1));
  return light;
}

function createSpotLight(station: ReturnType<typeof createStation>) {
  const light = new SpotLight(scene);
  light
    .setColor(new Vector4(1, 0.64, 0.34, 1))
    .setIntensity(18)
    .setRange(5.2)
    .setCutoff(Math.cos(Math.PI / 5))
    .setCastShadow(true);
  light.lookAt(
    Vector3.add(station.center, new Vector3(-1.25, 4.1, 1.65)),
    Vector3.add(station.center, new Vector3(0.25, 1.55, 0)),
    Vector3.axisPY(),
  );
  configureShadow(light);
  createLightMarker(
    Vector3.add(station.center, new Vector3(-1.25, 3.1, 1.65)),
    new Vector4(1, 0.64, 0.34, 1),
  );
  return light;
}

function configureShadow(light: DemoShadowLight) {
  light.shadow.mode = "pcf";
  light.shadow.shadowMapSize = 1024;
  light.shadow.depthBias = 0.5;
  light.shadow.normalBias = 1.5;
  light.shadow.pcfKernelSize = 5;
  light.shadow.nearClip = 0.1;
}

function createLightMarker(position: Vector3, color: Vector4) {
  const material = new LambertMaterial();
  material.albedoColor = color;
  const marker = new Mesh(scene, new SphereShape({ radius: 0.08 }), material);
  marker.position.set(position);
  marker.castShadow = false;
}

function animateStation(
  station: ShadowStation,
  seconds: number,
  index: number,
) {
  const phase = index * 0.7;
  const { center, blockers } = station;

  blockers.box.rotation.fromAxisAngle(Vector3.axisPY(), seconds * 0.9 + phase);
  blockers.box.position.y = 0.78 + Math.sin(seconds * 1.5 + phase) * 0.16;

  blockers.sphere.position.x =
    center.x + Math.sin(seconds * 0.8 + phase) * 0.55;
  blockers.sphere.position.z =
    center.z + 0.24 + Math.cos(seconds * 0.8 + phase) * 0.2;

  blockers.torus.rotation.set(
    Quaternion.fromEulerAngle(seconds * 0.8 + phase, seconds * 1.4, 0),
  );
}

function createMesh(
  shape: ConstructorParameters<typeof Mesh>[1],
  color: Vector4,
) {
  const material = new LambertMaterial();
  material.albedoColor = color;
  return new Mesh(scene, shape, material);
}

function wireUi(stateRef: typeof state, shadowLights: DemoShadowLight[]) {
  for (const mode of SHADOW_MODES) {
    const button = document.getElementById(`mode-${mode}`);
    button?.addEventListener("click", () => {
      stateRef.mode = mode;
      for (const light of shadowLights) {
        light.shadow.mode = mode as ShadowMode;
      }
      updateModeButtons(stateRef.mode);
    });
  }

  const toggleButton = document.getElementById("toggle-shadow");
  toggleButton?.addEventListener("click", () => {
    stateRef.shadowEnabled = !stateRef.shadowEnabled;
    for (const light of shadowLights) {
      light.castShadow = stateRef.shadowEnabled;
    }
    toggleButton.classList.toggle("active", stateRef.shadowEnabled);
    toggleButton.textContent = stateRef.shadowEnabled
      ? "Shadows On"
      : "Shadows Off";
  });
}

function updateModeButtons(activeMode: DemoShadowMode) {
  for (const mode of SHADOW_MODES) {
    document
      .getElementById(`mode-${mode}`)
      ?.classList.toggle("active", mode === activeMode);
  }
}

async function getBackend(): Promise<DeviceBackend> {
  const type = new URL(location.href).searchParams.get("dev") || "webgpu";
  if (type === "webgpu") {
    if (await backendWebGPU.supported()) {
      return backendWebGPU;
    }
    console.warn("No WebGPU support, fall back to WebGL2");
  }
  if (type === "webgl2" || type === "webgpu") {
    if (await backendWebGL2.supported()) {
      return backendWebGL2;
    }
    console.warn("No WebGL2 support, fall back to WebGL1");
  }
  return backendWebGL1;
}
