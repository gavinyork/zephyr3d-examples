import { backendWebGL2 } from '@zephyr3d/backend-webgl';
import { backendWebGPU } from '@zephyr3d/backend-webgpu';
import { Vector3, Vector4 } from '@zephyr3d/base';
import type { DeviceBackend } from '@zephyr3d/device';
import {
  Scene,
  OrbitCameraController,
  DirectionalLight,
  Application,
  PerspectiveCamera,
  BatchGroup,
  LambertMaterial,
  BoxShape,
  Mesh,
  getInput
} from '@zephyr3d/scene';

function getQueryString(name: string) {
  return new URL(window.location.toString()).searchParams.get(name) || null;
}

async function getBackend(): Promise<DeviceBackend> {
  const type = getQueryString('device') ?? 'webgpu';
  if (type === 'webgpu') {
    if (await backendWebGPU.supported()) {
      return backendWebGPU;
    } else {
      console.warn('No WebGPU support, fall back to WebGL2');
    }
  }
  return backendWebGL2;
}

const app = new Application({
  backend: await getBackend(),
  canvas: document.querySelector('#canvas')
});

app.ready().then(async () => {
  const device = app.device;
  const scene = new Scene();
  const camera = new PerspectiveCamera(scene, Math.PI / 3, 1, 1000);
  camera.position.setXYZ(0, 0, 15);
  camera.controller = new OrbitCameraController();
  camera.oitMode = device.type === 'webgl' ? 'weighted' : 'dual-depth';

  getInput().use(camera.handleEvent.bind(camera));

  const batchGroup = new BatchGroup(scene);
  const boxShape = new BoxShape();
  const d = 8;
  const transparentMeshes: Mesh[] = [];

  for (let i = 0; i < 30; i++) {
    const instanceMat = new LambertMaterial();
    instanceMat.blendMode = 'blend';
    instanceMat.albedoColor = new Vector4(Math.random(), Math.random(), Math.random(), Math.random());
    const transMesh = new Mesh(scene, boxShape, instanceMat);
    transMesh.position.setXYZ(
      Math.random() * d - 0.5 * d,
      Math.random() * d - 0.5 * d,
      Math.random() * d - 0.5 * d
    );
    transMesh.scale.scaleBy(Math.random() + 2.5);
    transMesh.parent = batchGroup;
    transparentMeshes.push(transMesh);
  }
  const light = new DirectionalLight(scene)
    .setCastShadow(false)
    .setColor(new Vector4(1, 1, 1, 1))
    .setIntensity(15);
  light.lookAt(Vector3.one(), Vector3.zero(), Vector3.axisPY());

  const state = {
    mode: camera.oitMode,
    visibleCount: transparentMeshes.length,
    animate: true
  };
  wireUi(state, camera, transparentMeshes, batchGroup, device.type === 'webgpu');

  app.on('resize', (width, height) => {
    camera.aspect = width / height;
  });

  app.on('tick', (_deltaMs, elapsedMs) => {
    camera.updateController();
    if (state.animate) {
      batchGroup.rotation.fromAxisAngle(Vector3.axisPY(), elapsedMs / 10000);
    }
    camera.render(scene);
    app.device.drawText(`OIT: ${state.mode} | Transparent objects: ${state.visibleCount}`, 20, 92, '#ffffff');
    app.device.drawText(
      `Device: ${device.type} | FPS: ${device.frameInfo.FPS.toFixed(1)}`,
      20,
      114,
      '#cffafe'
    );
  });

  app.run();
});

type OitMode = 'none' | 'weighted' | 'abuffer' | 'dual-depth';

function wireUi(
  state: { mode: OitMode; visibleCount: number; animate: boolean },
  camera: PerspectiveCamera,
  meshes: Mesh[],
  batchGroup: BatchGroup,
  isWebGpu: boolean
) {
  const modes: OitMode[] = ['none', 'weighted', 'abuffer', 'dual-depth'];
  const abufferButton = document.querySelector<HTMLButtonElement>('#mode-abuffer');
  if (abufferButton) {
    abufferButton.disabled = !isWebGpu;
    abufferButton.title = isWebGpu ? 'PPLL / ABuffer' : 'PPLL / ABuffer requires WebGPU';
  }

  for (const mode of modes) {
    document.querySelector<HTMLButtonElement>(`#mode-${mode}`)?.addEventListener('click', () => {
      if (mode === 'abuffer' && !isWebGpu) return;
      camera.oitMode = mode;
      state.mode = mode;
      updateModeButtons(mode);
      updateStatus(state, isWebGpu);
    });
  }

  const layers = document.querySelector<HTMLInputElement>('#layers');
  const layersValue = document.querySelector<HTMLOutputElement>('#layers-value');
  layers?.addEventListener('input', () => {
    state.visibleCount = Number(layers.value);
    meshes.forEach((mesh, index) => {
      mesh.showState = index < state.visibleCount ? 'visible' : 'hidden';
    });
    if (layersValue) layersValue.value = layers.value;
    updateStatus(state, isWebGpu);
  });

  document.querySelector<HTMLInputElement>('#animate')?.addEventListener('change', (event) => {
    state.animate = (event.target as HTMLInputElement).checked;
    if (!state.animate) batchGroup.rotation.fromAxisAngle(Vector3.axisPY(), 0);
  });

  meshes.forEach((mesh, index) => {
    mesh.showState = index < state.visibleCount ? 'visible' : 'hidden';
  });
  updateModeButtons(state.mode);
  updateStatus(state, isWebGpu);
}

function updateModeButtons(activeMode: OitMode) {
  for (const mode of ['none', 'weighted', 'abuffer', 'dual-depth']) {
    document.querySelector(`#mode-${mode}`)?.classList.toggle('active', mode === activeMode);
  }
}

function updateStatus(state: { mode: OitMode; visibleCount: number }, isWebGpu: boolean) {
  const status = document.querySelector('#status');
  if (status) {
    status.textContent = `${app.device.type} | ${state.visibleCount} transparent objects | ${state.mode}`;
  }
}
