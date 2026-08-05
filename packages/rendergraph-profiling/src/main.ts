import { DEPTH_CLEAR_VALUE, Matrix4x4, Quaternion, Vector3, Vector4 } from '@zephyr3d/base';
import { backendWebGPU } from '@zephyr3d/backend-webgpu';
import type { FrameBuffer, Texture2D } from '@zephyr3d/device';
import { DrawText } from '@zephyr3d/device';
import type { RGProfileResult, RGProfileScopeResult } from '@zephyr3d/scene';
import {
  Application,
  BoxShape,
  DevicePoolAllocator,
  RenderGraph,
  RenderGraphExecutor
} from '@zephyr3d/scene';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas');

function formatProfileScope(scope: RGProfileScopeResult, indent: string, lines: string[]): void {
  const duration = scope.status === 'resolved' ? `${scope.durationMs.toFixed(3)} ms` : scope.status;
  lines.push(`${indent}${scope.name}: ${duration}`);
  for (const child of scope.children) {
    formatProfileScope(child, `${indent}  `, lines);
  }
}

function formatProfileResult(result: RGProfileResult | null): string[] {
  if (!result) {
    return ['Profile: waiting for first result'];
  }
  const lines = [`Profile status: ${result.status}`];
  formatProfileScope(result.graph, '', lines);
  return lines.slice(0, 8);
}

// Application initializes the scene runtime and sets the current device used by scene helpers.
const myApp = new Application({
  backend: backendWebGPU,
  canvas
});

myApp.ready().then(async () => {
  const device = myApp.device;
  const primitive = new BoxShape({ size: 2 });

  // This shader program renders a lit-looking normal color into the offscreen render target.
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

  // This shader program samples the texture produced by the render graph and draws it to the screen.
  const programTextured = device.buildRenderProgram({
    vertex(pb) {
      this.projMatrix = pb.mat4().uniform(0);
      this.worldMatrix = pb.mat4().uniform(0);
      this.$inputs.position = pb.vec3().attrib('position');
      this.$inputs.uv = pb.vec2().attrib('texCoord0');
      this.$outputs.uv = pb.vec2();
      pb.main(function () {
        this.worldPos = pb.mul(this.worldMatrix, pb.vec4(this.$inputs.position, 1));
        this.$builtins.position = pb.mul(this.projMatrix, this.worldPos);
        this.$outputs.uv = this.$inputs.uv;
      });
    },
    fragment(pb) {
      this.tex = pb.tex2D().uniform(0);
      this.$outputs.color = pb.vec4();
      pb.main(function () {
        this.sampleColor = pb.textureSample(this.tex, this.$inputs.uv).rgb;
        this.$outputs.color = pb.vec4(pb.pow(this.sampleColor, pb.vec3(1 / 2.2)), 1);
      });
    }
  });
  const bindGroup = device.createBindGroup(program.bindGroupLayouts[0]);
  const bindGroupTextured = device.createBindGroup(programTextured.bindGroupLayouts[0]);

  // The executor owns graph execution. The allocator maps graph resource descriptors
  // to real GPU textures/framebuffers from the engine's device pool.
  const renderGraphAllocator = new DevicePoolAllocator();
  const renderGraphExecutor = new RenderGraphExecutor(
    renderGraphAllocator,
    myApp.device.getDrawingBufferWidth(),
    myApp.device.getDrawingBufferHeight(),
    {
      device,
      profiling: {
        enabled: true,
        graph: true,
        pass: true,
        subpass: true,
        includePendingUploads: true,
        label: 'RenderGraph Profiling'
      }
    }
  );
  myApp.on('tick', (deltaMs, elapsedMs) => {
    const t = elapsedMs * 0.002;
    const backBufferWidth = device.getDrawingBufferWidth();
    const backBufferHeight = device.getDrawingBufferHeight();
    const rotateMatrix = Quaternion.fromEulerAngle(t, t, 0).toMatrix4x4();
    const worldMatrix = Matrix4x4.translateLeft(rotateMatrix, new Vector3(0, 0, -4));
    let executionLayout = '';
    const profileLines = formatProfileResult(renderGraphExecutor.getLatestProfileResult());

    // Build a fresh graph for this frame. Handles returned by the builder are logical
    // resources; the executor allocates the actual GPU objects when the graph runs.
    const graph = new RenderGraph();

    // Pass 1: render the cube into a transient 512x512 color texture with depth.
    // Returning colorTexture lets later passes refer to this pass output by handle.
    const renderTargetColorTexture = graph.addPass('RenderToTexture', (builder) => {
      const colorTexture = builder.createTexture<Texture2D>({
        label: 'RenderTargetColor',
        format: 'rgba8unorm',
        sizeMode: 'absolute',
        width: 512,
        height: 512
      });
      const depthTexture = builder.createTexture<Texture2D>({
        label: 'RenderTargetDepth',
        format: 'd16',
        sizeMode: 'absolute',
        width: 512,
        height: 512
      });

      // A framebuffer is also a graph resource. Its attachments declare dependencies
      // on the color and depth textures created above.
      const framebuffer = builder.createFramebuffer<FrameBuffer>({
        label: 'RenderTargetFramebuffer',
        width: 512,
        height: 512,
        colorAttachments: colorTexture,
        depthAttachment: depthTexture
      });
      builder.addSubpass('DrawCube', (rgCtx) => {
        const projMatrix = Matrix4x4.perspective(1.5, 1, 1, 50);

        // Resolve the logical framebuffer handle to the real framebuffer for this pass.
        device.setFramebuffer(rgCtx.getFramebuffer(framebuffer));
        device.clearFrameBuffer(new Vector4(0.5, 0, 0, 1), DEPTH_CLEAR_VALUE, 0);
        bindGroup.setValue('worldMatrix', worldMatrix);
        bindGroup.setValue('projMatrix', projMatrix);
        device.setBindGroup(0, bindGroup);
        device.setProgram(program);
        primitive.draw();
      });
      builder.addSubpass('DrawOffscreenLabel', (rgCtx) => {
        device.setFramebuffer(rgCtx.getFramebuffer(framebuffer));
        DrawText.drawText(device, 'subpass texture', '#ffffff', 20, 20);
      });
      return colorTexture;
    });

    // Pass 2: draw to the swapchain using the texture produced by Pass 1.
    graph.addPass('RenderToScreen', (builder) => {
      // This read creates the dependency edge: RenderToScreen runs after RenderToTexture,
      // and the color texture stays alive until this pass finishes.
      builder.read(renderTargetColorTexture);

      // The backbuffer is not modeled as a graph resource in this small example, so
      // mark the pass as side-effecting to prevent it from being culled.
      builder.sideEffect();
      builder.setExecute((rgCtx) => {
        const projMatrix = Matrix4x4.perspective(1.5, backBufferWidth / backBufferHeight, 1, 50);
        device.setFramebuffer(null);
        device.clearFrameBuffer(new Vector4(0, 0, 0.5, 1), DEPTH_CLEAR_VALUE, 0);
        bindGroupTextured.setValue('worldMatrix', worldMatrix);
        bindGroupTextured.setValue('projMatrix', projMatrix);
        bindGroupTextured.setTexture('tex', rgCtx.getTexture(renderTargetColorTexture));
        device.setBindGroup(0, bindGroupTextured);
        device.setProgram(programTextured);
        primitive.draw();

        DrawText.drawText(device, 'RenderGraph: profiling', '#ffffff', 30, 30);
        DrawText.drawText(device, `Execution: ${executionLayout}`, '#ffffff', 30, 50);
        DrawText.drawText(device, `Device: ${device.type}`, '#ffffff', 30, 70);
        DrawText.drawText(device, `FPS: ${device.frameInfo.FPS.toFixed(2)}`, '#ffff00', 30, 90);
        for (let i = 0; i < profileLines.length; i++) {
          DrawText.drawText(device, profileLines[i], '#a8e6ff', 30, 120 + i * 20);
        }
      });
    });

    renderGraphExecutor.setBackbufferSize(device.getDrawingBufferWidth(), device.getDrawingBufferHeight());
    try {
      // The graph has no texture output because the final result is written to the screen.
      // The side-effect pass is enough to keep the whole dependency chain alive.
      const compiled = graph.compile([]);
      executionLayout = compiled.orderedPasses
        .map((pass) =>
          pass.subpasses.length > 0
            ? `${pass.name}[${pass.subpasses.map((subpass) => subpass.name).join(' -> ')}]`
            : pass.name
        )
        .join(' -> ');
      renderGraphExecutor.execute(compiled);
    } finally {
      // Clear per-frame executor state even if a pass fails while debugging the graph.
      renderGraphExecutor.reset();
    }
  });

  myApp.run();
});
