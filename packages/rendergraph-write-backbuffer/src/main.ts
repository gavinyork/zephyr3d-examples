import { Matrix4x4, Quaternion, Vector3, Vector4 } from '@zephyr3d/base';
import { backendWebGL1, backendWebGL2 } from '@zephyr3d/backend-webgl';
import { backendWebGPU } from '@zephyr3d/backend-webgpu';
import type { DeviceBackend } from '@zephyr3d/device';
import { DrawText } from '@zephyr3d/device';
import {
  Application,
  BoxShape,
  DevicePoolAllocator,
  RenderGraph,
  RenderGraphExecutor
} from '@zephyr3d/scene';

const backendsMap: Record<string, DeviceBackend> = {
  webgl: backendWebGL1,
  webgl2: backendWebGL2,
  webgpu: backendWebGPU
};

const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
const type = new URL(location.href).searchParams.get('dev') || 'webgl';
const backend = backendsMap[type];
if (!backend) {
  throw new Error(`Invalid backend: ${type}`);
}

// Application initializes the scene runtime and sets the current device used by scene helpers.
const myApp = new Application({
  backend,
  canvas
});

myApp.ready().then(async () => {
  const device = myApp.device;
  const primitive = new BoxShape({ size: 2 });

  // This shader program renders a lit-looking normal color to the imported backbuffer output.
  const program = device.buildRenderProgram({
    vertex(pb) {
      this.projMatrix = pb.mat4().uniform(0);
      this.worldMatrix = pb.mat4().uniform(0);
      this.$inputs.position = pb.vec3().attrib('position');
      this.$inputs.normal = pb.vec3().attrib('normal');
      this.$outputs.normal = pb.vec3();
      pb.main(function () {
        this.worldPos = pb.mul(this.worldMatrix, pb.vec4(this.$inputs.position, 1));
        this.$builtins.position = pb.mul(this.projMatrix, this.worldPos);
        this.$outputs.normal = this.$inputs.normal;
      });
    },
    fragment(pb) {
      this.$outputs.color = pb.vec4();
      pb.main(function () {
        this.normal = pb.add(pb.mul(pb.normalize(this.$inputs.normal), 0.5), pb.vec3(0.5));
        this.$outputs.color = pb.vec4(pb.pow(this.normal, pb.vec3(1 / 2.2)), 1);
      });
    }
  });

  const bindGroup = device.createBindGroup(program.bindGroupLayouts[0]);

  // The executor owns graph execution. The allocator maps graph resource descriptors
  // to real GPU textures/framebuffers from the engine's device pool.
  const renderGraphAllocator = new DevicePoolAllocator();
  const renderGraphExecutor = new RenderGraphExecutor(
    renderGraphAllocator,
    myApp.device.getDrawingBufferWidth(),
    myApp.device.getDrawingBufferHeight()
  );
  myApp.on('tick', (_deltaMs, elapsedMs) => {
    const t = elapsedMs * 0.002;
    const backBufferWidth = device.getDrawingBufferWidth();
    const backBufferHeight = device.getDrawingBufferHeight();
    const rotateMatrix = Quaternion.fromEulerAngle(t, t, 0).toMatrix4x4();
    const worldMatrix = Matrix4x4.translateLeft(rotateMatrix, new Vector3(0, 0, -4));

    const graph = new RenderGraph();
    const backbuffer = graph.importTexture('backbuffer');
    let compiledPassNames = '';

    const presentedBackbuffer = graph.addPass('DrawCubeToBackbuffer', (builder) => {
      // write() creates the post-write version of the imported backbuffer.
      // The returned handle is the graph output passed to compile().
      const outputBackbuffer = builder.write(backbuffer);
      builder.setExecute(() => {
        const projMatrix = Matrix4x4.perspective(1.5, backBufferWidth / backBufferHeight, 1, 50);
        device.setFramebuffer(null);
        device.clearFrameBuffer(new Vector4(0.06, 0.06, 0.08, 1), 1, 0);
        bindGroup.setValue('worldMatrix', worldMatrix);
        bindGroup.setValue('projMatrix', projMatrix);
        device.setBindGroup(0, bindGroup);
        device.setProgram(program);
        primitive.draw();

        DrawText.drawText(device, 'RenderGraph: write-backbuffer', '#ffffff', 30, 30);
        DrawText.drawText(device, `Output: ${outputBackbuffer.name}`, '#ffffff', 30, 50);
        DrawText.drawText(device, `Executed passes: ${compiledPassNames}`, '#ffffff', 30, 70);
        DrawText.drawText(device, `Device: ${device.type}`, '#ffffff', 30, 90);
        DrawText.drawText(device, `FPS: ${device.frameInfo.FPS.toFixed(2)}`, '#ffff00', 30, 110);
      });
      return outputBackbuffer;
    });

    renderGraphExecutor.setBackbufferSize(backBufferWidth, backBufferHeight);
    try {
      const compiled = graph.compile([presentedBackbuffer]);
      compiledPassNames = compiled.orderedPasses.map((pass) => pass.name).join(' -> ');
      renderGraphExecutor.execute(compiled);
    } finally {
      // Clear per-frame executor state even if a pass fails while debugging the graph.
      renderGraphExecutor.reset();
    }
  });

  myApp.run();
});
